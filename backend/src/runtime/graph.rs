use crate::error::AppError;
use crate::provider::openai::OpenAiProvider;
use crate::runtime::context;
use crate::runtime::nodes;
use crate::runtime::templates::GraphConfig;
use crate::routes::sessions::SessionConfig;
use sqlx::SqlitePool;

/// Execute a graph for one turn. Returns the final narrative text.
pub async fn execute_graph(
    pool: &SqlitePool,
    provider: &OpenAiProvider,
    model: &str,
    session_id: &str,
    turn_number: i32,
    graph: &GraphConfig,
    user_input: &str,
    session_config: &SessionConfig,
) -> Result<String, AppError> {
    let context_bundle = context::build_context(
        pool,
        session_id,
        turn_number,
        session_config.max_context_turns as usize,
    )
    .await?;

    let mut executed_count: u32 = 0;
    let mut current_node_id = graph.entry.clone();
    let mut director_plan: Option<String> = None;
    let mut narrative_text = String::new();

    tracing::info!(
        session = session_id,
        turn = turn_number,
        entry = %graph.entry,
        nodes = graph.nodes.len(),
        "Graph execution started"
    );

    loop {
        if executed_count >= graph.max_total_nodes {
            tracing::warn!(
                session = session_id,
                turn = turn_number,
                executed = executed_count,
                "Graph max_total_nodes reached, stopping"
            );
            break;
        }

        // Find the current node
        let node = match graph.nodes.iter().find(|n| n.id == current_node_id) {
            Some(n) => n,
            None => {
                tracing::warn!(
                    session = session_id,
                    node_id = %current_node_id,
                    "Node not found in graph, stopping"
                );
                break;
            }
        };

        tracing::info!(
            session = session_id,
            turn = turn_number,
            node_id = %node.id,
            node_type = %node.node_type,
            "Executing node"
        );

        // Dispatch to node executor
        let output = match node.node_type.as_str() {
            "DirectorNode" => {
                nodes::execute_director(
                    provider,
                    model,
                    &context_bundle,
                    user_input,
                    &session_config.system_prompt,
                )
                .await?
            }
            "WorldJudgeNode" => {
                // Stub: WorldJudge acts like a director with a different prompt
                nodes::execute_director(
                    provider,
                    model,
                    &context_bundle,
                    user_input,
                    &session_config.system_prompt,
                )
                .await?
            }
            "WriterNode" => {
                nodes::execute_writer(
                    provider,
                    model,
                    &context_bundle,
                    user_input,
                    director_plan.as_deref(),
                    &session_config.system_prompt,
                )
                .await?
            }
            "MemoryNode" => {
                nodes::execute_memory(provider, model, user_input, &narrative_text, turn_number)
                    .await?
            }
            other => {
                tracing::warn!(
                    session = session_id,
                    node_id = %node.id,
                    node_type = other,
                    "Unsupported node type, skipping"
                );
                // Find next node via sequence edge and continue
                if let Some(edge) = graph.edges.iter().find(|e| e.from == current_node_id) {
                    current_node_id = edge.to.clone();
                    continue;
                } else {
                    break;
                }
            }
        };

        // Record trace for this node
        if let Err(e) = nodes::record_node_trace(pool, session_id, turn_number, &output, model).await
        {
            tracing::warn!(
                session = session_id,
                node_id = %output.node_id,
                "Failed to record trace: {}", e
            );
        }

        // Capture outputs for downstream nodes
        match output.node_type.as_str() {
            "DirectorNode" | "WorldJudgeNode" => {
                director_plan = Some(output.text.clone());
            }
            "WriterNode" => {
                narrative_text = output.text.clone();
            }
            _ => {}
        }

        executed_count += 1;

        // Follow sequence edge to next node
        if let Some(edge) = graph.edges.iter().find(|e| e.from == current_node_id) {
            current_node_id = edge.to.clone();
        } else {
            // No outgoing edge — we're done
            break;
        }
    }

    tracing::info!(
        session = session_id,
        turn = turn_number,
        nodes_executed = executed_count,
        narrative_len = narrative_text.len(),
        "Graph execution completed"
    );

    Ok(narrative_text)
}
