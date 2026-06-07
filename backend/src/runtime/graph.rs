use crate::error::AppError;
use crate::routes::sessions::SessionConfig;
use crate::runtime::executor::resolve_model_target;
use crate::runtime::types::{AgentCall, AgentStatusEvent, AgentTrace, AgentType};
use crate::runtime::{
    compression, context, dag, master, parser, plan_validator, sub_agent, turn_finalizer,
    turn_state, variable_tool_agent,
};
use sqlx::SqlitePool;
use std::sync::Arc;
use tokio::sync::Semaphore;
use tokio::sync::mpsc::UnboundedSender;
use tracing::instrument;

/// Maximum number of sub-agents that can execute concurrently within a single DAG level.
const MAX_CONCURRENT_AGENTS: usize = 4;

/// Execute one turn using the dynamic Master Agent architecture.
/// Returns the final narrative text.
///
/// Flow: ContextBundle → Parser → Master → Sub-agents → Writer → Compression
#[instrument(skip(pool, _provider, session_config, user_input), fields(session = session_id, turn = turn_number))]
pub async fn execute_multi_agent_turn(
    pool: &SqlitePool,
    _provider: &crate::provider::openai::OpenAiProvider,
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
    let parser_agent = active_agents
        .iter()
        .find(|a| a.agent_type == AgentType::Parser);
    let parsed_intent = if session_config.parser_enabled {
        let sub_model = resolve_model(model, &session_config.sub_agent_model);
        let target = resolve_model_target(pool, model, sub_model).await?;
        emit_status(&status_tx, "parser", "解析器", "working");
        match parser::run_parser(
            &target.provider,
            &target.model,
            user_input,
            &ctx,
            parser_agent,
        )
        .await
        {
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
    let master_target = resolve_model_target(pool, model, master_model).await?;
    let master_agent = active_agents
        .iter()
        .find(|a| a.agent_type == AgentType::Master);

    emit_status(&status_tx, "master", "总控", "working");
    let plan = master::run_master(
        &master_target.provider,
        &master_target.model,
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
    let mut validated = plan_validator::validate_plan(
        &plan,
        &active_agents,
        session_config.max_active_agents as usize,
    );

    // 6.6. Inject State Agent into the plan if variables exist and Master didn't include one.
    // State Agent runs after NPC/User, before Writer — uses tool call to update variables.
    let has_variables = ctx
        .structured_state
        .get("variables")
        .and_then(|v| v.as_object())
        .map_or(false, |obj| !obj.is_empty());
    let has_state_in_plan = validated
        .calls
        .iter()
        .any(|c| active_agents.iter().any(|a| a.id == c.agent_id && a.agent_type == AgentType::State));

    if has_variables && !has_state_in_plan {
        if let Some(state_agent) = active_agents.iter().find(|a| a.agent_type == AgentType::State) {
            // State Agent depends on all NPC/User agents (reads their outputs to determine changes)
            let npc_user_ids: Vec<String> = validated
                .calls
                .iter()
                .filter(|c| {
                    active_agents
                        .iter()
                        .find(|a| a.id == c.agent_id)
                        .map_or(false, |a| {
                            matches!(a.agent_type, AgentType::Npc | AgentType::User)
                        })
                })
                .map(|c| c.agent_id.clone())
                .collect();

            tracing::info!(
                session = session_id,
                agent_id = %state_agent.id,
                depends_on = ?npc_user_ids,
                "Injecting State Agent into DAG"
            );

            validated.calls.push(AgentCall {
                agent_id: state_agent.id.clone(),
                task: "分析以上角色的互动输出和当前变量状态，判断哪些变量需要变化。调用 update_variables 工具提交变更。".to_string(),
                inject_from: npc_user_ids,
            });
        }
    }

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
        let mut level_targets = Vec::new();

        for call in level {
            let agent = active_agents.iter().find(|a| a.id == call.agent_id);
            let agent = match agent {
                Some(a) => a,
                None => {
                    tracing::warn!(agent_id = %call.agent_id, "Agent not found, skipping");
                    continue;
                }
            };

            if agent.agent_type == AgentType::Writer {
                writer_called = true;
            }

            // Per-agent model: agent.config.model → session sub_agent_model → global default
            let agent_config: crate::runtime::types::AgentConfig =
                serde_json::from_value(agent.config.clone()).unwrap_or_default();
            let effective_model = agent_config
                .model
                .as_deref()
                .filter(|m| !m.is_empty())
                .unwrap_or(sub_model);
            let target = resolve_model_target(pool, model, effective_model).await?;

            emit_status(
                &status_tx,
                agent.agent_type.as_str(),
                &agent.label,
                "working",
            );
            level_agents.push(agent);
            level_calls.push(call);
            level_targets.push(target);
        }

        // Build futures after the borrow loop
        let mut futures = Vec::new();
        for i in 0..level_agents.len() {
            // State Agent gets the update_variables tool; other agents get None
            let agent_tools = if level_agents[i].agent_type == AgentType::State {
                let variables = ctx
                    .structured_state
                    .get("variables")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({}));
                Some(vec![variable_tool_agent::build_update_variables_tool(&variables)])
            } else {
                None
            };
            futures.push(sub_agent::execute_sub_agent(
                pool,
                &level_targets[i].provider,
                &level_targets[i].model,
                level_agents[i],
                level_calls[i],
                &state,
                &ctx,
                agent_tools,
            ));
        }

        // Execute all agents in this level with bounded concurrency
        let semaphore = Arc::new(Semaphore::new(MAX_CONCURRENT_AGENTS));
        let bounded_futures: Vec<_> = futures
            .into_iter()
            .map(|fut| {
                let sem = semaphore.clone();
                async move {
                    let _permit = sem.acquire().await.unwrap();
                    fut.await
                }
            })
            .collect();
        let results = futures::future::join_all(bounded_futures).await;

        // Process results
        for (i, result) in results.into_iter().enumerate() {
            let agent = level_agents[i];
            let agent_model = &level_targets[i].trace_model;
            emit_status(&status_tx, agent.agent_type.as_str(), &agent.label, "done");

            match result {
                Ok(output) => {
                    // Process State Agent tool calls to update variables
                    if agent.agent_type == AgentType::State {
                        if let Some(ref tool_calls) = output.tool_calls {
                            let variables = ctx
                                .structured_state
                                .get("variables")
                                .cloned()
                                .unwrap_or_else(|| serde_json::json!({}));
                            if let Some(changes) =
                                variable_tool_agent::extract_tool_call(tool_calls, &variables)
                            {
                                tracing::info!(
                                    session = session_id,
                                    agent_id = %agent.id,
                                    changes = changes.len(),
                                    "State Agent tool call: applying variable changes"
                                );
                                match pool.begin().await {
                                    Ok(mut tx) => {
                                        match variable_tool_agent::persist_variable_changes(
                                            &mut tx,
                                            session_id,
                                            &changes,
                                        )
                                        .await
                                        {
                                            Ok(()) => {
                                                if let Err(e) = tx.commit().await {
                                                    tracing::warn!("Failed to commit state agent changes: {}", e);
                                                }
                                            }
                                            Err(e) => {
                                                tracing::warn!("Failed to persist state agent changes: {}", e);
                                                let _ = tx.rollback().await;
                                            }
                                        }
                                    }
                                    Err(e) => {
                                        tracing::warn!("Failed to begin transaction for state agent: {}", e);
                                    }
                                }
                            }
                        }
                    }

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
                        agent_type: agent.agent_type.as_str().to_string(),
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
            .filter(|a| a.agent_type == AgentType::Writer)
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
            let writer_target = resolve_model_target(pool, model, sub_model).await?;
            let output = sub_agent::execute_sub_agent(
                pool,
                &writer_target.provider,
                &writer_target.model,
                writer,
                &call,
                &state,
                &ctx,
                None,
            )
            .await?;
            emit_status(&status_tx, "writer", &writer.label, "done");
            sub_agent::touch_agent(pool, &writer.id, turn_number).await;
            traces.push(build_agent_trace(&output, &writer_target.trace_model));
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
            .filter(|o| o.agent_type == AgentType::Writer)
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

    // 11. Post-turn compression: generate memory updates (persisted by caller)
    let sub_model = resolve_model(model, &session_config.sub_agent_model);
    let state_agent = active_agents
        .iter()
        .find(|a| a.agent_type == AgentType::State);
    let compression_model = if session_config.compression_model.is_empty() {
        sub_model
    } else {
        &session_config.compression_model
    };
    let compression_target = resolve_model_target(pool, model, compression_model).await?;

    let (compression_result, compression_job) = if run_compression_inline {
        emit_status(&status_tx, "state", "压缩", "working");
        let result = match compression::generate_compression(
            &compression_target.provider,
            &compression_target.model,
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
        narrative,
        traces,
        compression: compression_result,
        compression_job,
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
        agent_type: output.agent_type.as_str().to_string(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::types::AgentOutput;

    fn make_output(agent_id: &str, agent_type: AgentType, text: &str) -> AgentOutput {
        AgentOutput {
            agent_id: agent_id.to_string(),
            agent_type,
            text: text.to_string(),
            tool_calls: None,
            prompt_tokens: 100,
            completion_tokens: 50,
            duration_ms: 200,
        }
    }

    #[test]
    fn build_agent_trace_copies_fields_correctly() {
        let output = make_output("npc_1", AgentType::Npc, "Hello, traveler!");
        let trace = build_agent_trace(&output, "gpt-4o");

        assert_eq!(trace.agent_id, "npc_1");
        assert_eq!(trace.agent_type, "npc");
        assert_eq!(trace.prompt_tokens, 100);
        assert_eq!(trace.completion_tokens, 50);
        assert_eq!(trace.duration_ms, 200);
        assert_eq!(trace.model, "gpt-4o");
        assert!(trace.input_summary.contains("npc_1"));
        assert!(trace.input_summary.contains("100 tokens"));
        assert!(trace.output_summary.contains("Hello, traveler!"));
    }

    #[test]
    fn build_agent_trace_truncates_long_output() {
        let long_text = "a".repeat(300);
        let output = make_output("writer_1", AgentType::Writer, &long_text);
        let trace = build_agent_trace(&output, "model-x");

        // output_summary should be truncated to 200 chars of the text + agent_id prefix
        assert!(trace.output_summary.len() < long_text.len() + 50);
        // The summary should contain the first 200 chars of the text
        assert!(trace.output_summary.contains(&"a".repeat(200)));
    }

    #[test]
    fn build_agent_trace_short_output_not_truncated() {
        let short_text = "Short reply.";
        let output = make_output("npc_1", AgentType::Npc, short_text);
        let trace = build_agent_trace(&output, "model");

        assert!(trace.output_summary.contains(short_text));
    }

    #[test]
    fn resolve_model_returns_default_when_override_empty() {
        let result = resolve_model("gpt-4o", "");
        assert_eq!(result, "gpt-4o");
    }

    #[test]
    fn resolve_model_returns_override_when_non_empty() {
        let result = resolve_model("gpt-4o", "claude-3-opus");
        assert_eq!(result, "claude-3-opus");
    }

    #[test]
    fn emit_status_sends_event_through_channel() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        emit_status(&Some(tx), "writer", "写手", "working");

        let event = rx.try_recv().expect("should receive one event");
        assert_eq!(event.agent_type, "writer");
        assert_eq!(event.label, "写手");
        assert_eq!(event.status, "working");
    }

    #[test]
    fn emit_status_none_sender_does_not_panic() {
        // Should not panic when sender is None
        emit_status(&None, "parser", "解析器", "done");
    }
}
