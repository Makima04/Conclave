use crate::runtime::types::AgentCall;
use std::collections::{HashMap, VecDeque};

/// A level in the DAG — agents that can run in parallel (no dependencies between them).
pub type ExecutionLevel = Vec<AgentCall>;

/// Compile a list of AgentCalls into execution levels based on inject_from dependencies.
///
/// Uses Kahn's algorithm for topological sorting with cycle detection.
/// Calls forming a cycle are removed with a warning; remaining calls are still executed.
///
/// Example: calls = [A(inject=[]), B(inject=[A]), C(inject=[]), D(inject=[B,C])]
/// → Level 0: [A, C]  (parallel)
/// → Level 1: [B]     (depends on A)
/// → Level 2: [D]     (depends on B and C)
pub fn compile_dag(calls: &[AgentCall]) -> Vec<ExecutionLevel> {
    if calls.is_empty() {
        return vec![];
    }

    // Build position map: agent_id → index in calls
    let position: HashMap<&str, usize> = calls
        .iter()
        .enumerate()
        .map(|(i, c)| (c.agent_id.as_str(), i))
        .collect();

    let n = calls.len();

    // Build adjacency: dependency → dependent (for Kahn's)
    // and in-degree count
    let mut in_degree = vec![0usize; n];
    let mut dependents: HashMap<usize, Vec<usize>> = HashMap::new(); // dep_idx → [dependent_idx]

    for (i, call) in calls.iter().enumerate() {
        for dep_id in &call.inject_from {
            if let Some(&dep_idx) = position.get(dep_id.as_str()) {
                // In-plan dependency
                dependents.entry(dep_idx).or_default().push(i);
                in_degree[i] += 1;
            }
            // External dependencies (not in plan) don't affect in-degree
        }
    }

    // Kahn's algorithm: BFS from nodes with in-degree 0
    let mut queue: VecDeque<usize> = VecDeque::new();
    let mut depth = vec![0usize; n];
    let mut processed = 0;

    for i in 0..n {
        if in_degree[i] == 0 {
            queue.push_back(i);
        }
    }

    while let Some(idx) = queue.pop_front() {
        processed += 1;
        if let Some(deps) = dependents.get(&idx) {
            for &dep_idx in deps {
                depth[dep_idx] = depth[dep_idx].max(depth[idx] + 1);
                in_degree[dep_idx] -= 1;
                if in_degree[dep_idx] == 0 {
                    queue.push_back(dep_idx);
                }
            }
        }
    }

    // Detect cycles: any node with in_degree > 0 is part of a cycle
    if processed < n {
        let cycle_ids: Vec<&str> = (0..n)
            .filter(|&i| in_degree[i] > 0)
            .map(|i| calls[i].agent_id.as_str())
            .collect();
        tracing::warn!(
            "DAG cycle detected, removing {} calls: {:?}",
            cycle_ids.len(),
            cycle_ids
        );
    }

    // Build levels from processed (non-cyclic) calls only
    let max_depth = depth.iter().copied().max().unwrap_or(0);
    let mut levels: Vec<ExecutionLevel> = vec![vec![]; max_depth + 1];
    let mut has_entries = false;

    for i in 0..n {
        if in_degree[i] == 0 {
            levels[depth[i]].push(calls[i].clone());
            has_entries = true;
        }
    }

    if !has_entries {
        return vec![];
    }

    // Remove empty levels
    levels.retain(|l| !l.is_empty());

    levels
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(id: &str, inject: &[&str]) -> AgentCall {
        AgentCall {
            agent_id: id.to_string(),
            task: "test".to_string(),
            inject_from: inject.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn empty_calls() {
        assert!(compile_dag(&[]).is_empty());
    }

    #[test]
    fn all_independent() {
        let calls = vec![call("A", &[]), call("B", &[]), call("C", &[])];
        let levels = compile_dag(&calls);
        assert_eq!(levels.len(), 1);
        assert_eq!(levels[0].len(), 3);
    }

    #[test]
    fn linear_chain() {
        let calls = vec![call("A", &[]), call("B", &["A"]), call("C", &["B"])];
        let levels = compile_dag(&calls);
        assert_eq!(levels.len(), 3);
        assert_eq!(levels[0][0].agent_id, "A");
        assert_eq!(levels[1][0].agent_id, "B");
        assert_eq!(levels[2][0].agent_id, "C");
    }

    #[test]
    fn diamond() {
        let calls = vec![
            call("A", &[]),
            call("B", &["A"]),
            call("C", &["A"]),
            call("D", &["B", "C"]),
        ];
        let levels = compile_dag(&calls);
        assert_eq!(levels.len(), 3);
        assert_eq!(levels[0].len(), 1); // A
        assert_eq!(levels[1].len(), 2); // B, C (parallel)
        assert_eq!(levels[2].len(), 1); // D
    }

    #[test]
    fn external_dependency() {
        // B depends on "writer" which is not in the plan — treated as external
        let calls = vec![call("A", &["writer"]), call("B", &[])];
        let levels = compile_dag(&calls);
        // Both at depth 0 since external deps don't increase depth
        assert_eq!(levels.len(), 1);
        assert_eq!(levels[0].len(), 2);
    }

    #[test]
    fn simple_cycle() {
        // A depends on B, B depends on A → both in cycle, removed
        let calls = vec![call("A", &["B"]), call("B", &["A"])];
        let levels = compile_dag(&calls);
        // Both are in a cycle → empty result
        assert!(levels.is_empty() || levels.iter().all(|l| l.is_empty()));
    }

    #[test]
    fn self_dependency() {
        // A depends on itself → cycle, removed
        let calls = vec![call("A", &["A"]), call("B", &[])];
        let levels = compile_dag(&calls);
        // Only B survives
        assert_eq!(levels.len(), 1);
        assert_eq!(levels[0].len(), 1);
        assert_eq!(levels[0][0].agent_id, "B");
    }

    #[test]
    fn transitive_cycle() {
        // A→B→C→A forms a cycle; D is independent
        let calls = vec![
            call("A", &["C"]),
            call("B", &["A"]),
            call("C", &["B"]),
            call("D", &[]),
        ];
        let levels = compile_dag(&calls);
        // Only D survives
        let all_calls: Vec<&str> = levels
            .iter()
            .flat_map(|l| l.iter().map(|c| c.agent_id.as_str()))
            .collect();
        assert_eq!(all_calls, vec!["D"]);
    }

    #[test]
    fn partial_cycle() {
        // A→B→A (cycle), C is independent, D depends on C
        let calls = vec![
            call("A", &["B"]),
            call("B", &["A"]),
            call("C", &[]),
            call("D", &["C"]),
        ];
        let levels = compile_dag(&calls);
        // A and B are in cycle (removed), C and D survive
        let all_calls: Vec<&str> = levels
            .iter()
            .flat_map(|l| l.iter().map(|c| c.agent_id.as_str()))
            .collect();
        assert!(all_calls.contains(&"C"));
        assert!(all_calls.contains(&"D"));
        assert!(!all_calls.contains(&"A"));
        assert!(!all_calls.contains(&"B"));
    }
}
