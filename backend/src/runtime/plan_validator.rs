use crate::runtime::types::{AgentCall, LifecycleAction, MasterPlan, SubAgent};
use tracing;

/// Validated plan output — calls and lifecycle actions that passed all checks.
pub struct ValidatedPlan {
    pub calls: Vec<AgentCall>,
    pub lifecycle: Vec<LifecycleAction>,
    pub user_auto: bool,
    pub warnings: Vec<String>,
}

/// Validate a MasterPlan against runtime constraints.
/// Invalid calls/actions are stripped (not rejected wholesale). Warnings are logged.
pub fn validate_plan(
    plan: &MasterPlan,
    active_agents: &[SubAgent],
    max_active_agents: usize,
) -> ValidatedPlan {
    let mut warnings: Vec<String> = Vec::new();

    // Validate calls
    let mut valid_calls: Vec<AgentCall> = Vec::new();
    let mut seen_ids: Vec<String> = Vec::new();

    for call in &plan.calls {
        // 1. Agent must exist in active list
        let agent = active_agents.iter().find(|a| a.id == call.agent_id);
        if agent.is_none() {
            warnings.push(format!(
                "Call skipped: agent '{}' not found in active list",
                call.agent_id
            ));
            continue;
        }

        // 2. Task length limit
        if call.task.len() > 2000 {
            warnings.push(format!(
                "Call truncated: agent '{}' task too long ({} chars)",
                call.agent_id,
                call.task.len()
            ));
        }

        // 3. inject_from must reference earlier calls in this plan or active agents
        for dep_id in &call.inject_from {
            let is_earlier_call = seen_ids.contains(dep_id);
            let is_active_agent = active_agents.iter().any(|a| &a.id == dep_id);
            if !is_earlier_call && !is_active_agent {
                warnings.push(format!(
                    "Call for '{}': inject_from '{}' not found, ignoring dependency",
                    call.agent_id, dep_id
                ));
            }
        }

        seen_ids.push(call.agent_id.clone());
        valid_calls.push(AgentCall {
            agent_id: call.agent_id.clone(),
            task: if call.task.len() > 2000 {
                call.task.chars().take(2000).collect()
            } else {
                call.task.clone()
            },
            inject_from: call.inject_from.clone(),
        });
    }

    // 4. Cap calls at max_active_agents
    if valid_calls.len() > max_active_agents {
        warnings.push(format!(
            "Calls capped from {} to max_active_agents={}",
            valid_calls.len(),
            max_active_agents
        ));
        valid_calls.truncate(max_active_agents);
    }

    // Validate lifecycle actions
    let mut valid_lifecycle: Vec<LifecycleAction> = Vec::new();

    for action in &plan.lifecycle {
        // 5. Only allowed action types
        if !matches!(
            action.action.as_str(),
            "create" | "cooldown" | "delete" | "restore"
        ) {
            warnings.push(format!(
                "Lifecycle action skipped: unknown action '{}'",
                action.action
            ));
            continue;
        }

        // 6. Cannot delete permanent agents
        if action.action == "delete" {
            if let Some(ref agent_id) = action.character_id {
                if let Some(agent) = active_agents.iter().find(|a| &a.id == agent_id) {
                    if is_permanent_type(&agent.agent_type) {
                        warnings.push(format!(
                            "Lifecycle delete skipped: agent '{}' ({}) is permanent",
                            agent.label, agent.agent_type
                        ));
                        continue;
                    }
                }
            }
        }

        // 7. Lifecycle actions cap
        if valid_lifecycle.len() >= 5 {
            warnings.push("Lifecycle actions capped at 5".to_string());
            break;
        }

        valid_lifecycle.push(action.clone());
    }

    if !warnings.is_empty() {
        tracing::warn!(
            "PlanValidator: {} warnings for plan with {} calls, {} lifecycle actions",
            warnings.len(),
            plan.calls.len(),
            plan.lifecycle.len()
        );
        for w in &warnings {
            tracing::warn!("  PlanValidator: {}", w);
        }
    }

    ValidatedPlan {
        calls: valid_calls,
        lifecycle: valid_lifecycle,
        user_auto: plan.user_auto,
        warnings,
    }
}

fn is_permanent_type(agent_type: &str) -> bool {
    matches!(
        agent_type,
        "master" | "parser" | "writer" | "director" | "state"
    )
}
