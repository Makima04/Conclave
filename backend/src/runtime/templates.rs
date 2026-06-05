use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct GraphConfig {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub entry: String,
    #[serde(default = "default_loop_count")]
    pub max_loop_count: u32,
    #[serde(default = "default_total_nodes")]
    pub max_total_nodes: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GraphNode {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    #[serde(default)]
    pub config: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GraphEdge {
    pub from: String,
    pub to: String,
    #[serde(rename = "type")]
    pub edge_type: String,
    #[serde(default)]
    pub condition: Option<String>,
}

fn default_loop_count() -> u32 {
    2
}
fn default_total_nodes() -> u32 {
    8
}

pub fn get_template(mode: &str) -> GraphConfig {
    let json = match mode {
        "strict_director" => STRICT_DIRECTOR_GRAPH,
        "collaborative_director" => COLLABORATIVE_DIRECTOR_GRAPH,
        "multi_npc_scene" => MULTI_NPC_SCENE_GRAPH,
        _ => SINGLE_AGENT_GRAPH,
    };
    serde_json::from_str(json).expect("invalid template graph JSON")
}

const SINGLE_AGENT_GRAPH: &str = r#"{
    "nodes": [
        {"id": "writer", "type": "WriterNode", "config": {}},
        {"id": "memory", "type": "MemoryNode", "config": {}}
    ],
    "edges": [
        {"from": "writer", "to": "memory", "type": "sequence"}
    ],
    "entry": "writer",
    "max_loop_count": 1,
    "max_total_nodes": 2
}"#;

const STRICT_DIRECTOR_GRAPH: &str = r#"{
    "nodes": [
        {"id": "director", "type": "DirectorNode", "config": {}},
        {"id": "world_judge", "type": "WorldJudgeNode", "config": {}},
        {"id": "writer", "type": "WriterNode", "config": {}},
        {"id": "memory", "type": "MemoryNode", "config": {}}
    ],
    "edges": [
        {"from": "director", "to": "world_judge", "type": "sequence"},
        {"from": "world_judge", "to": "writer", "type": "sequence"},
        {"from": "writer", "to": "memory", "type": "sequence"}
    ],
    "entry": "director",
    "max_loop_count": 2,
    "max_total_nodes": 8
}"#;

const COLLABORATIVE_DIRECTOR_GRAPH: &str = r#"{
    "nodes": [
        {"id": "director", "type": "DirectorNode", "config": {}},
        {"id": "writer", "type": "WriterNode", "config": {}},
        {"id": "memory", "type": "MemoryNode", "config": {}}
    ],
    "edges": [
        {"from": "director", "to": "writer", "type": "sequence"},
        {"from": "writer", "to": "memory", "type": "sequence"}
    ],
    "entry": "director",
    "max_loop_count": 2,
    "max_total_nodes": 8
}"#;

const MULTI_NPC_SCENE_GRAPH: &str = r#"{
    "nodes": [
        {"id": "director", "type": "DirectorNode", "config": {}},
        {"id": "writer", "type": "WriterNode", "config": {}},
        {"id": "memory", "type": "MemoryNode", "config": {}}
    ],
    "edges": [
        {"from": "director", "to": "writer", "type": "sequence"},
        {"from": "writer", "to": "memory", "type": "sequence"}
    ],
    "entry": "director",
    "max_loop_count": 2,
    "max_total_nodes": 8
}"#;
