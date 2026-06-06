use crate::error::AppError;
use crate::provider::openai::OpenAiProvider;
use crate::routes::sessions::SessionConfig;
use crate::runtime::types::{AgentCall, AgentStatusEvent, AgentTrace};
use crate::runtime::{
    compression, context, dag, master, parser, plan_validator, sub_agent, turn_finalizer,
    turn_state, variable_state_agent,
};
use sqlx::SqlitePool;
use tokio::sync::mpsc::UnboundedSender;
use tracing::instrument;

/// Execute one turn using the dynamic Master Agent architecture.
/// Returns the final narrative text.
///
/// Flow: ContextBundle → Parser → Master → Sub-agents → Writer → Compression
#[instrument(skip(pool, provider, session_config, user_input), fields(session = session_id, turn = turn_number))]
pub async fn execute_multi_agent_turn(
    pool: &SqlitePool,
    provider: &OpenAiProvider,
    model: &str,
    session_id: &str,
    turn_number: i32,
    user_input: &str,
    session_config: &SessionConfig,
    status_tx: Option<UnboundedSender<AgentStatusEvent>>,
    run_compression_inline: bool,
) -> Result<turn_finalizer::TurnCommit, AppError> {
    // 1. Build ContextBundle (structured state + events + foreshadowing + summaries)
    let ctx = context::build_context(
        pool,
        session_id,
        turn_number,
        session_config.max_context_turns as usize,
    )
    .await?;

    tracing::info!(
        session = session_id,
        turn = turn_number,
        events = ctx.events.len(),
        foreshadowing = ctx.foreshadowing.len(),
        has_summary = ctx.scene_summary.is_some(),
        has_state = !ctx
            .structured_state
            .as_object()
            .map_or(true, |o| o.is_empty()),
        context_msgs = ctx.recent_context.len(),
        "ContextBundle built for multi-agent turn"
    );

    // 2. Auto-cooldown inactive agents
    sub_agent::check_cooldowns(pool, session_id, session_config.cooldown_turns, turn_number)
        .await?;

    // 3. Get active agents
    let active_agents = sub_agent::get_active_agents(pool, session_id).await?;

    tracing::info!(
        session = session_id,
        turn = turn_number,
        active_agents = active_agents.len(),
        "Multi-agent turn started"
    );

    // 4. Run Parser Agent → extract structured intent
    let parser_agent = active_agents.iter().find(|a| a.agent_type == "parser");
    let parsed_intent = if session_config.parser_enabled {
        let sub_model = resolve_model(model, &session_config.sub_agent_model);
        emit_status(&status_tx, "parser", "解析器", "working");
        match parser::run_parser(provider, sub_model, user_input, &ctx, parser_agent).await {
            Ok(intent) => {
                emit_status(&status_tx, "parser", "解析器", "done");
                tracing::info!(
                    session = session_id,
                    intent = %intent.intent,
                    action = %intent.action_type,
                    tone = %intent.tone,
                    targets = ?intent.target_characters,
                    "Parser completed"
                );
                Some(intent)
            }
            Err(e) => {
                emit_status(&status_tx, "parser", "解析器", "done");
                tracing::warn!("Parser failed: {}, continuing without intent", e);
                None
            }
        }
    } else {
        None
    };

    // 5. Create turn state + trace accumulator
    let mut state = turn_state::new(turn_number, user_input);
    let mut traces: Vec<AgentTrace> = Vec::new();

    // 6. Run Master Agent → execution plan (with full context)
    let master_model = resolve_model(model, &session_config.master_model);
    let master_agent = active_agents.iter().find(|a| a.agent_type == "master");

    emit_status(&status_tx, "master", "总控", "working");
    let plan = master::run_master(
        provider,
        master_model,
        user_input,
        &active_agents,
        &state,
        &ctx,
        parsed_intent.as_ref(),
        master_agent,
    )
    .await?;
    emit_status(&status_tx, "master", "总控", "done");

    tracing::info!(
        session = session_id,
        turn = turn_number,
        calls = plan.calls.len(),
        lifecycle = plan.lifecycle.len(),
        user_auto = plan.user_auto,
        "Master plan received"
    );

    // 6.5. Validate plan against runtime constraints
    let validated = plan_validator::validate_plan(
        &plan,
        &active_agents,
        session_config.max_active_agents as usize,
    );

    // 7. Execute lifecycle actions
    for action in &validated.lifecycle {
        match action.action.as_str() {
            "create" => {
                let new_agent =
                    sub_agent::create_agent(pool, session_id, action, turn_number).await?;
                tracing::info!(agent_id = %new_agent.id, "Agent created by Master");
            }
            "cooldown" => {
                if let Some(agent_id) = &action.character_id {
                    sub_agent::cooldown_agent(pool, agent_id, &action.reason, turn_number).await?;
                }
            }
            "delete" => {
                if let Some(agent_id) = &action.character_id {
                    sub_agent::delete_agent(pool, agent_id).await?;
                }
            }
            "restore" => {
                if let Some(agent_id) = &action.character_id {
                    sub_agent::restore_agent(pool, agent_id, turn_number).await?;
                }
            }
            _ => {
                tracing::warn!(action = %action.action, "Unknown lifecycle action");
            }
        }
    }

    // Re-fetch active agents after lifecycle changes
    let active_agents = sub_agent::get_active_agents(pool, session_id).await?;

    // 8. Execute agent calls using DAG-based parallel execution
    let sub_model = resolve_model(model, &session_config.sub_agent_model);
    let levels = dag::compile_dag(&validated.calls);

    tracing::info!(
        session = session_id,
        turn = turn_number,
        levels = levels.len(),
        total_calls = validated.calls.len(),
        "DAG compiled for parallel execution"
    );

    let mut writer_called = false;

    for (level_idx, level) in levels.iter().enumerate() {
        // Collect agent info first (to avoid borrow conflicts with futures)
        let mut level_agents = Vec::new();
        let mut level_calls = Vec::new();
        let mut level_models: Vec<String> = Vec::new();

        for call in level {
            let agent = active_agents.iter().find(|a| a.id == call.agent_id);
            let agent = match agent {
                Some(a) => a,
                None => {
                    tracing::warn!(agent_id = %call.agent_id, "Agent not found, skipping");
                    continue;
                }
            };

            if agent.agent_type == "writer" {
                writer_called = true;
            }

            // Per-agent model: agent.config.model → session sub_agent_model → global default
            let agent_config: crate::runtime::types::AgentConfig =
                serde_json::from_value(agent.config.clone()).unwrap_or_default();
            let effective_model = agent_config
                .model
                .as_deref()
                .filter(|m| !m.is_empty())
                .unwrap_or(sub_model)
                .to_string();

            emit_status(&status_tx, &agent.agent_type, &agent.label, "working");
            level_agents.push(agent);
            level_calls.push(call);
            level_models.push(effective_model);
        }

        // Build futures after the borrow loop
        let mut futures = Vec::new();
        for i in 0..level_agents.len() {
            futures.push(sub_agent::execute_sub_agent(
                pool,
                provider,
                &level_models[i],
                level_agents[i],
                level_calls[i],
                &state,
                &ctx,
            ));
        }

        // Execute all agents in this level concurrently
        let results = futures::future::join_all(futures).await;

        // Process results
        for (i, result) in results.into_iter().enumerate() {
            let agent = level_agents[i];
            let agent_model = &level_models[i];
            emit_status(&status_tx, &agent.agent_type, &agent.label, "done");

            match result {
                Ok(output) => {
                    sub_agent::touch_agent(pool, &agent.id, turn_number).await;
                    traces.push(build_agent_trace(&output, agent_model));
                    turn_state::set_output(&mut state, &agent.id, output);
                }
                Err(e) => {
                    tracing::warn!(
                        agent_id = %agent.id,
                        agent_type = %agent.agent_type,
                        level = level_idx,
                        "Agent execution failed: {}", e
                    );
                    // Record error trace
                    traces.push(crate::runtime::types::AgentTrace {
                        agent_id: agent.id.clone(),
                        agent_type: agent.agent_type.clone(),
                        prompt_tokens: 0,
                        completion_tokens: 0,
                        duration_ms: 0,
                        input_summary: format!("Level {} agent call", level_idx),
                        output_summary: format!("ERROR: {}", e),
                        model: agent_model.to_string(),
                    });
                }
            }
        }

        tracing::debug!(
            session = session_id,
            turn = turn_number,
            level = level_idx,
            agents = level.len(),
            "DAG level completed"
        );
    }

    // 9. If no writer was called, call one by default (deterministic: first by id)
    if !writer_called {
        let writers: Vec<_> = active_agents
            .iter()
            .filter(|a| a.agent_type == "writer")
            .collect();
        let writer = if let Some(ref fid) = plan.final_writer_id {
            writers
                .iter()
                .find(|w| w.id == *fid)
                .or_else(|| writers.first())
                .copied()
        } else {
            writers.first().copied()
        };
        if let Some(writer) = writer {
            let all_output_ids: Vec<String> = state.agent_outputs.keys().cloned().collect();
            let call = AgentCall {
                agent_id: writer.id.clone(),
                task: "根据以上互动，创作叙事文本。如果没有其他Agent的输出，则直接回应用户的输入。"
                    .to_string(),
                inject_from: all_output_ids,
            };
            emit_status(&status_tx, "writer", &writer.label, "working");
            let output = sub_agent::execute_sub_agent(
                pool, provider, sub_model, writer, &call, &state, &ctx,
            )
            .await?;
            emit_status(&status_tx, "writer", &writer.label, "done");
            sub_agent::touch_agent(pool, &writer.id, turn_number).await;
            traces.push(build_agent_trace(&output, sub_model));
            turn_state::set_output(&mut state, &writer.id, output);
        }
    }

    // 10. Extract final narrative from writer output (deterministic selection)
    let narrative = if let Some(ref writer_id) = plan.final_writer_id {
        // Explicit writer specified by master plan
        state
            .agent_outputs
            .values()
            .find(|o| o.agent_id == *writer_id)
            .map(|o| o.text.clone())
    } else {
        // Fall back to the last writer in plan call order, or first by id
        let writer_outputs: Vec<_> = state
            .agent_outputs
            .values()
            .filter(|o| o.agent_type == "writer")
            .collect();
        if writer_outputs.len() == 1 {
            writer_outputs.first().map(|o| o.text.clone())
        } else if writer_outputs.len() > 1 {
            // Use the one that appears last in the plan's calls array
            plan.calls
                .iter()
                .rev()
                .find_map(|c| writer_outputs.iter().find(|o| o.agent_id == c.agent_id))
                .map(|o| o.text.clone())
        } else {
            None
        }
    }
    .unwrap_or_else(|| {
        state
            .agent_outputs
            .values()
            .map(|o| o.text.clone())
            .collect::<Vec<_>>()
            .join("\n\n")
    });

    // 11. Variable state update: state agent proposes concrete `variables.*` changes.
    let sub_model = resolve_model(model, &session_config.sub_agent_model);
    let state_agent = active_agents.iter().find(|a| a.agent_type == "state");
    let mut state_proposals = Vec::new();
    if let Some(agent) = state_agent {
        emit_status(&status_tx, "state", &agent.label, "working");
        match variable_state_agent::propose_variable_changes(
            provider,
            sub_model,
            user_input,
            &narrative,
            &ctx,
            Some(agent),
        )
        .await
        {
            Ok(Some(proposal)) => {
                tracing::info!(
                    session = session_id,
                    turn = turn_number,
                    changes = proposal.changes.len(),
                    "State agent proposed variable changes"
                );
                state_proposals.push(proposal);
            }
            Ok(None) => {
                tracing::debug!(
                    session = session_id,
                    turn = turn_number,
                    "State agent proposed no variable changes"
                );
            }
            Err(e) => {
                tracing::warn!(
                    session = session_id,
                    turn = turn_number,
                    "State agent variable update failed: {}",
                    e
                );
            }
        }
        emit_status(&status_tx, "state", &agent.label, "done");
    }

    // 12. Post-turn compression: generate memory updates (persisted by caller)
    let compression_model = if session_config.compression_model.is_empty() {
        sub_model
    } else {
        &session_config.compression_model
    };

    let (compression_result, compression_job) = if run_compression_inline {
        emit_status(&status_tx, "state", "压缩", "working");
        let result = match compression::generate_compression(
            provider,
            compression_model,
            user_input,
            &narrative,
            &ctx,
            state_agent,
        )
        .await
        {
            Ok(cr) => {
                emit_status(&status_tx, "state", "压缩", "done");
                tracing::info!(
                    session = session_id,
                    turn = turn_number,
                    events_count = cr.events.len(),
                    foreshadow_count = cr.foreshadowing.len(),
                    state_changes = cr.state_changes.len(),
                    summary_len = cr.scene_summary.len(),
                    "Compression completed"
                );
                Some(cr)
            }
            Err(e) => {
                emit_status(&status_tx, "state", "压缩", "done");
                tracing::warn!(
                    session = session_id,
                    turn = turn_number,
                    "Compression failed: {}",
                    e
                );
                None
            }
        };
        (result, None)
    } else {
        (
            None,
            Some(turn_finalizer::CompressionJob {
                model: compression_model.to_string(),
                user_input: user_input.to_string(),
                narrative: narrative.clone(),
                context: ctx.clone(),
                state_agent: state_agent.cloned(),
            }),
        )
    };

    tracing::info!(
        session = session_id,
        turn = turn_number,
        narrative_len = narrative.len(),
        agents_executed = state.agent_outputs.len(),
        "Multi-agent turn completed"
    );

    Ok(turn_finalizer::TurnCommit {
        turn_number,
        narrative,
        traces,
        compression: compression_result,
        compression_job,
        state_proposals,
    })
}

fn build_agent_trace(output: &crate::runtime::types::AgentOutput, model: &str) -> AgentTrace {
    let input_summary = format!("{}: {} tokens", output.agent_id, output.prompt_tokens);
    let output_summary = format!(
        "{}: {}",
        output.agent_id,
        if output.text.chars().count() > 200 {
            output.text.chars().take(200).collect::<String>()
        } else {
            output.text.clone()
        }
    );
    AgentTrace {
        agent_id: output.agent_id.clone(),
        agent_type: output.agent_type.clone(),
        prompt_tokens: output.prompt_tokens,
        completion_tokens: output.completion_tokens,
        duration_ms: output.duration_ms,
        input_summary,
        output_summary,
        model: model.to_string(),
    }
}

fn resolve_model<'a>(default: &'a str, override_model: &'a str) -> &'a str {
    if override_model.is_empty() {
        default
    } else {
        override_model
    }
}

fn emit_status(
    tx: &Option<UnboundedSender<AgentStatusEvent>>,
    agent_type: &str,
    label: &str,
    status: &str,
) {
    if let Some(tx) = tx {
        let _ = tx.send(AgentStatusEvent {
            agent_type: agent_type.to_string(),
            label: label.to_string(),
            status: status.to_string(),
        });
    }
}
