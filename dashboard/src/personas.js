/**
 * Agent personas — maps the first 8 hex chars of each agent's public key
 * to a name, emoji, and personality trait shown in the UI.
 *
 * Keys are matched with agentKey.startsWith(prefix).
 * Update the prefixes here if you regenerate keys.
 */
export const PERSONAS = {
  // Orchestrator
  '027c413c': { name: 'Nexus',   emoji: '⬡', role: 'orchestrator', trait: 'Task master · posts 1.6 jobs/sec'         },

  // Labelers
  '02307586': { name: 'Aria',    emoji: '🔵', role: 'labeler', trait: 'Lightning fast · never misses a bid'           },
  '034af58f': { name: 'Bruno',   emoji: '🟠', role: 'labeler', trait: 'Methodical · highest confidence scores'        },
  '02ecbba1': { name: 'Cleo',    emoji: '🟣', role: 'labeler', trait: 'Aggressive bidder · high win rate'             },
  '029a7ec0': { name: 'Dash',    emoji: '🟡', role: 'labeler', trait: 'Speed specialist · sub-ms labels'              },
  '03a17294': { name: 'Echo',    emoji: '🔴', role: 'labeler', trait: 'Consistent · rarely wrong'                     },
  '0340e184': { name: 'Flux',    emoji: '🟢', role: 'labeler', trait: 'Variable latency · wins when it counts'        },
  '02d1217d': { name: 'Grit',    emoji: '⚪', role: 'labeler', trait: 'Never gives up · retries on failure'           },
  '02c95ee3': { name: 'Halo',    emoji: '🔷', role: 'labeler', trait: 'Reliable · steady throughput all day'          },
  '0254a35b': { name: 'Iris',    emoji: '🔶', role: 'labeler', trait: 'Pattern expert · strong on neutrals'           },
  '026222bb': { name: 'Jazz',    emoji: '🟥', role: 'labeler', trait: 'Creative · finds sentiment others miss'        },
}

/**
 * Returns the persona for a given agentKey (or a fallback).
 */
export function getPersona(agentKey) {
  if (!agentKey) return null
  const prefix = agentKey.slice(0, 8)
  return PERSONAS[prefix] || { name: agentKey.slice(0, 8) + '…', emoji: '◆', trait: 'Unknown agent' }
}
