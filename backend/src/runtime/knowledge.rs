use crate::error::AppError;
use crate::provider::openai::OpenAiProvider;
use crate::provider::types::{ChatMessage, ChatRequest};
use crate::runtime::structured_output;
use crate::runtime::types::{AgentType, ContextBundle, KnowledgeEvent, RoleContext};
use sqlx::SqlitePool;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct KnowledgeExtraction {
    #[serde(default)]
    pub events: Vec<KnowledgeEvent>,
}

pub async fn generate_knowledge_events(
    provider: &OpenAiProvider,
    model: &str,
    user_input: &str,
    narrative: &str,
    context: &ContextBundle,
) -> Result<KnowledgeExtraction, AppError> {
    let roles = format_roles(&context.role_contexts);
    let recent = context
        .recent_context
        .iter()
        .rev()
        .take(4)
        .rev()
        .map(|m| format!("[{}] {}", m.role, m.content))
        .collect::<Vec<_>>()
        .join("\n");

    let system_prompt = r#"你是多Agent RP的知识边界解析器。你的任务不是写作，而是从本轮用户输入和最终叙事中抽取“谁知道什么”的事实。

输出纯JSON，不要解释。

JSON格式：
{
  "events": [
    {
      "fact": "事实描述",
      "source_type": "speech|action|visual_observation|inner_monologue|narration|inference",
      "actors": ["行动或事实主体"],
      "targets": ["被作用对象"],
      "observers": ["明确看见/听见的人"],
      "knowers": ["知道该事实的角色名"],
      "visibility": "public|private|observed_by|told_to|writer_only",
      "confidence": 0.0,
      "evidence": "简短证据原文"
    }
  ]
}

规则：
1. 明确说出口的信息，knowers包含说话者和听见者。
2. 明确可观察的动作、表情、状态，knowers包含在场观察者和本人。
3. 内心独白、秘密动机、未说出口的想法，只给本人；如果无法确定本人，visibility=writer_only。
4. 旁白/作者视角知道但角色未必知道的内容，visibility=writer_only。
5. 不确定是否可见时，visibility=writer_only，knowers=[]。
6. 不要把角色不该知道的信息写入其knowers。
7. knowers必须使用“当前参与角色”中的角色名；writer/director不需要写进knowers。"#;

    let user_content = format!(
        "当前参与角色:\n{}\n\n最近对话:\n{}\n\n用户输入:\n{}\n\n最终叙事:\n{}",
        if roles.is_empty() { "(无)" } else { &roles },
        if recent.is_empty() { "(无)" } else { &recent },
        user_input,
        narrative
    );

    let request = ChatRequest {
        model: model.to_string(),
        messages: vec![
            ChatMessage {
                role: "system".to_string(),
                content: system_prompt.to_string(),
                reasoning_content: None,
                tool_calls: None,
            },
            ChatMessage {
                role: "user".to_string(),
                content: user_content,
                reasoning_content: None,
                tool_calls: None,
            },
        ],
        temperature: Some(0.1),
        top_p: Some(1.0),
        max_tokens: Some(4000),
        frequency_penalty: None,
        presence_penalty: None,
        tools: None,
        tool_choice: None,
        stream: false,
        ..Default::default()
    };

    let response = provider
        .chat_completion_with_retry(request, 2)
        .await
        .map_err(|e| AppError::Provider(e.to_string()))?;
    let text = response
        .choices
        .first()
        .map(|c| c.message.content.clone())
        .unwrap_or_default();
    let schema_hint = r#"{"events":[{"fact":"...","source_type":"speech|action|visual_observation|inner_monologue|narration|inference","actors":[],"targets":[],"observers":[],"knowers":[],"visibility":"writer_only","confidence":0.5,"evidence":"..."}]}"#;

    structured_output::parse_with_repair(provider, model, &text, parse_knowledge, schema_hint)
        .await
        .map_err(|e| AppError::Provider(e.to_string()))
}

fn parse_knowledge(text: &str) -> Result<KnowledgeExtraction, String> {
    let json_str = if let Some(start) = text.find('{') {
        if let Some(end) = text.rfind('}') {
            &text[start..=end]
        } else {
            text
        }
    } else {
        text
    };
    serde_json::from_str::<KnowledgeExtraction>(json_str)
        .map_err(|e| format!("JSON parse error: {}", e))
}

pub async fn persist_knowledge_events(
    pool: &SqlitePool,
    session_id: &str,
    turn_number: i32,
    extraction: &KnowledgeExtraction,
) -> Result<(), AppError> {
    let known_actors = load_actor_names(pool, session_id).await?;
    let now = chrono::Utc::now().to_rfc3339();
    for event in &extraction.events {
        if event.fact.trim().is_empty() {
            continue;
        }
        let mut knowers = filter_known_actors(&event.knowers, &known_actors);
        let mut visibility = normalize_visibility(&event.visibility).to_string();
        if visibility != "public" && knowers.is_empty() {
            visibility = "writer_only".to_string();
        }
        if visibility == "writer_only" {
            knowers.clear();
        }
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO agent_knowledge_events (id, session_id, turn_number, fact, source_type, actors, targets, observers, knowers, visibility, confidence, evidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(&id)
        .bind(session_id)
        .bind(turn_number)
        .bind(event.fact.trim())
        .bind(normalize_source_type(&event.source_type))
        .bind(json_array(&event.actors))
        .bind(json_array(&event.targets))
        .bind(json_array(&event.observers))
        .bind(json_array(&knowers))
        .bind(visibility)
        .bind(event.confidence.clamp(0.0, 1.0))
        .bind(event.evidence.trim())
        .bind(&now)
        .execute(pool)
        .await?;
    }
    Ok(())
}

pub async fn persist_fallback_writer_only(
    pool: &SqlitePool,
    session_id: &str,
    turn_number: i32,
    narrative: &str,
) -> Result<(), AppError> {
    let evidence: String = narrative.chars().take(300).collect();
    let extraction = KnowledgeExtraction {
        events: vec![KnowledgeEvent {
            fact: "本轮发生了新的叙事事件，但知识边界解析失败，未向角色传播。".to_string(),
            source_type: "narration".to_string(),
            visibility: "writer_only".to_string(),
            confidence: 0.0,
            evidence,
            turn_number,
            ..Default::default()
        }],
    };
    persist_knowledge_events(pool, session_id, turn_number, &extraction).await
}

pub fn visible_to_agent(
    event: &KnowledgeEvent,
    agent: &RoleContext,
    agent_type: AgentType,
) -> bool {
    if matches!(
        agent_type,
        AgentType::Writer
            | AgentType::Director
            | AgentType::Master
            | AgentType::State
            | AgentType::Parser
    ) {
        return true;
    }
    if event.visibility == "public" {
        return true;
    }
    if event.visibility == "writer_only" {
        return false;
    }
    event.knowers.iter().any(|k| {
        same_actor(k, &agent.label)
            || agent
                .character_id
                .as_deref()
                .is_some_and(|id| same_actor(k, id))
    })
}

fn same_actor(a: &str, b: &str) -> bool {
    let a = a.trim();
    let b = b.trim();
    !a.is_empty() && !b.is_empty() && a == b
}

fn format_roles(roles: &[RoleContext]) -> String {
    roles
        .iter()
        .map(|r| format!("- {} ({})", r.label, r.agent_type))
        .collect::<Vec<_>>()
        .join("\n")
}

fn json_array(values: &[String]) -> String {
    serde_json::to_string(values).unwrap_or_else(|_| "[]".to_string())
}

async fn load_actor_names(pool: &SqlitePool, session_id: &str) -> Result<Vec<String>, AppError> {
    let rows = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT label, character_id FROM sub_agents WHERE session_id = ? AND status = 'active' AND agent_type IN ('user', 'npc')",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    let mut names = Vec::new();
    for (label, character_id) in rows {
        if !label.trim().is_empty() {
            names.push(label);
        }
        if let Some(id) = character_id {
            if !id.trim().is_empty() {
                names.push(id);
            }
        }
    }
    Ok(names)
}

fn filter_known_actors(values: &[String], known_actors: &[String]) -> Vec<String> {
    values
        .iter()
        .filter(|value| known_actors.iter().any(|known| same_actor(value, known)))
        .cloned()
        .collect()
}

fn normalize_source_type(value: &str) -> &str {
    match value {
        "speech" | "action" | "visual_observation" | "inner_monologue" | "narration"
        | "inference" => value,
        _ => "narration",
    }
}

fn normalize_visibility(value: &str) -> &str {
    match value {
        "public" | "private" | "observed_by" | "told_to" | "writer_only" => value,
        _ => "writer_only",
    }
}
