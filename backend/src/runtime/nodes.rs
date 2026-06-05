use crate::error::AppError;
use crate::provider::adapter::ProviderAdapter;
use crate::provider::openai::OpenAiProvider;
use crate::provider::types::{ChatMessage, ChatRequest};
use crate::runtime::types::ContextBundle;
use sqlx::SqlitePool;

/// Result from a node execution
pub struct NodeOutput {
    pub text: String,
    pub node_id: String,
    pub node_type: String,
    pub output_type: String,
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub duration_ms: i32,
}

/// Shared LLM call helper for all node types
async fn node_llm_call(
    provider: &OpenAiProvider,
    model: &str,
    system_prompt: &str,
    user_content: &str,
    temperature: f32,
    max_tokens: i32,
) -> Result<(String, u32, u32), AppError> {
    let request = ChatRequest {
        model: model.to_string(),
        messages: vec![
            ChatMessage {
                role: "system".to_string(),
                content: system_prompt.to_string(),
            },
            ChatMessage {
                role: "user".to_string(),
                content: user_content.to_string(),
            },
        ],
        temperature: Some(temperature),
        top_p: None,
        max_tokens: Some(max_tokens as u32),
        frequency_penalty: None,
        presence_penalty: None,
        stream: false,
    };

    let response = provider
        .chat_completion(request)
        .await
        .map_err(|e| AppError::Provider(e.to_string()))?;
    let text = response
        .choices
        .first()
        .map(|c| c.message.content.clone())
        .unwrap_or_default();
    let prompt_tokens = response.usage.as_ref().map(|u| u.prompt_tokens).unwrap_or(0);
    let completion_tokens = response
        .usage
        .as_ref()
        .map(|u| u.completion_tokens)
        .unwrap_or(0);

    Ok((text, prompt_tokens, completion_tokens))
}

/// Director node: analyzes user input, produces a plan
pub async fn execute_director(
    provider: &OpenAiProvider,
    model: &str,
    context: &ContextBundle,
    user_input: &str,
    session_config_prompt: &str,
) -> Result<NodeOutput, AppError> {
    let start = std::time::Instant::now();

    let system_prompt = format!(
        "{}\n\nYou are the Director of this roleplay scene. Your job:\n\
         1. Analyze the user's action/intent\n\
         2. Decide which characters and world elements are involved\n\
         3. Check for consistency with established facts\n\
         4. Plan the narrative beats for this turn\n\n\
         Output a brief plan (3-5 bullet points) for the Writer to follow. \
         Do NOT write the final narrative yourself.",
        if session_config_prompt.is_empty() {
            "You are a roleplay scene director."
        } else {
            session_config_prompt
        }
    );

    let mut user_content = format!("User action: {}\n\n", user_input);
    if let Some(summary) = &context.scene_summary {
        user_content.push_str(&format!("Scene context: {}\n\n", summary));
    }
    if !context.events.is_empty() {
        user_content.push_str(&format!(
            "Recent events:\n{}\n\n",
            context.events.join("\n")
        ));
    }
    if !context.foreshadowing.is_empty() {
        user_content.push_str(&format!(
            "Active foreshadowing:\n{}\n\n",
            context.foreshadowing.join("\n")
        ));
    }

    let (text, pt, ct) = node_llm_call(provider, model, &system_prompt, &user_content, 0.7, 1024).await?;
    let duration_ms = start.elapsed().as_millis() as i32;

    Ok(NodeOutput {
        text,
        node_id: "director".to_string(),
        node_type: "DirectorNode".to_string(),
        output_type: "plan_result".to_string(),
        prompt_tokens: pt,
        completion_tokens: ct,
        duration_ms,
    })
}

/// Writer node: synthesizes the final narrative
pub async fn execute_writer(
    provider: &OpenAiProvider,
    model: &str,
    context: &ContextBundle,
    user_input: &str,
    director_plan: Option<&str>,
    session_config_prompt: &str,
) -> Result<NodeOutput, AppError> {
    let start = std::time::Instant::now();

    let system_prompt = if session_config_prompt.is_empty() {
        super::executor::default_system_prompt()
    } else {
        session_config_prompt.to_string()
    };

    let mut messages = vec![ChatMessage {
        role: "system".to_string(),
        content: system_prompt,
    }];

    for msg in &context.recent_context {
        messages.push(ChatMessage {
            role: msg.role.clone(),
            content: msg.content.clone(),
        });
    }

    if let Some(plan) = director_plan {
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: format!("Director's plan for this turn:\n{}", plan),
        });
    }

    if !context.events.is_empty() {
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: format!("Known events:\n{}", context.events.join("\n")),
        });
    }

    if !context.foreshadowing.is_empty() {
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: format!(
                "Active foreshadowing threads:\n{}",
                context.foreshadowing.join("\n")
            ),
        });
    }

    if let Some(summary) = &context.scene_summary {
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: format!("Scene summary: {}", summary),
        });
    }

    messages.push(ChatMessage {
        role: "user".to_string(),
        content: user_input.to_string(),
    });

    let request = ChatRequest {
        model: model.to_string(),
        messages,
        temperature: Some(0.8),
        top_p: Some(1.0),
        max_tokens: Some(2048),
        frequency_penalty: Some(0.0),
        presence_penalty: Some(0.0),
        stream: false,
    };

    let response = provider
        .chat_completion(request)
        .await
        .map_err(|e| AppError::Provider(e.to_string()))?;
    let text = response
        .choices
        .first()
        .map(|c| c.message.content.clone())
        .unwrap_or_default();
    let pt = response.usage.as_ref().map(|u| u.prompt_tokens).unwrap_or(0);
    let ct = response
        .usage
        .as_ref()
        .map(|u| u.completion_tokens)
        .unwrap_or(0);
    let duration_ms = start.elapsed().as_millis() as i32;

    Ok(NodeOutput {
        text,
        node_id: "writer".to_string(),
        node_type: "WriterNode".to_string(),
        output_type: "writer_draft".to_string(),
        prompt_tokens: pt,
        completion_tokens: ct,
        duration_ms,
    })
}

/// Memory node: extracts events and state changes from the turn
pub async fn execute_memory(
    provider: &OpenAiProvider,
    model: &str,
    user_input: &str,
    assistant_reply: &str,
    turn_number: i32,
) -> Result<NodeOutput, AppError> {
    let start = std::time::Instant::now();

    let system_prompt = "You are a memory extraction agent for a roleplay system. \
         Given the user's action and the assistant's narrative response, extract:\n\
         1. Key events that occurred (with event types: action, dialogue, discovery, combat, state_change, world_event)\n\
         2. Any character relationship or state changes\n\
         3. Any foreshadowing elements planted\n\n\
         Output a structured summary in JSON format:\n\
         {\"events\": [...], \"state_changes\": [...], \"foreshadowing\": [...]}\n\
         If nothing notable happened, return empty arrays.";

    let user_content = format!(
        "Turn {}:\nUser: {}\n\nAssistant response:\n{}",
        turn_number, user_input, assistant_reply
    );

    let (text, pt, ct) =
        node_llm_call(provider, model, system_prompt, &user_content, 0.3, 1024).await?;
    let duration_ms = start.elapsed().as_millis() as i32;

    // TODO: parse the JSON output into MemoryProposal when structured extraction is implemented
    tracing::debug!(
        turn = turn_number,
        memory_output_len = text.len(),
        "Memory node extracted"
    );

    Ok(NodeOutput {
        text,
        node_id: "memory".to_string(),
        node_type: "MemoryNode".to_string(),
        output_type: "memory_proposal".to_string(),
        prompt_tokens: pt,
        completion_tokens: ct,
        duration_ms,
    })
}

/// Record a trace for a node execution
pub async fn record_node_trace(
    pool: &SqlitePool,
    session_id: &str,
    turn_number: i32,
    output: &NodeOutput,
    model: &str,
) -> Result<(), AppError> {
    let trace_id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let token_usage = serde_json::json!({
        "prompt_tokens": output.prompt_tokens,
        "completion_tokens": output.completion_tokens
    });
    let model_config = serde_json::json!({"model": model});

    sqlx::query(
        r#"INSERT INTO traces (id, session_id, turn_number, node_id, node_type, agent_id,
           input_summary, output_summary, output_type, model_config, token_usage, duration_ms, created_at)
           VALUES (?, ?, ?, ?, ?, 'graph', ?, ?, ?, ?, ?, ?, ?)"#,
    )
    .bind(&trace_id)
    .bind(session_id)
    .bind(turn_number)
    .bind(&output.node_id)
    .bind(&output.node_type)
    .bind(&format!("{}: {} tokens in", output.node_id, output.prompt_tokens))
    .bind(&format!(
        "{}: {} tokens out",
        output.node_id, output.completion_tokens
    ))
    .bind(&output.output_type)
    .bind(model_config.to_string())
    .bind(token_usage.to_string())
    .bind(output.duration_ms)
    .bind(&now)
    .execute(pool)
    .await?;

    Ok(())
}
