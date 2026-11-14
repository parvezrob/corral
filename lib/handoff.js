// Handing work to the agent you're working with: the one in the shown tab, else
// in the shown space. `hc send` pastes and presses Enter, and waits while you
// have an unfinished draft in that agent.
import { agents, focused, hc, notify } from "herdr";
import { pickAgent, agentName } from "./pr.js";

/** The agent "Send to …" goes to right now, or null. */
export function currentAgent() {
  const f = focused();
  return pickAgent(agents(), f?.tab ?? null, f?.space ?? null);
}

/** "Send to Claude", or "Send to agent" when there's none to name. */
export function sendLabel() {
  return `Send to ${agentName(currentAgent())}`;
}

/**
 * Sends text to the current agent; rejects when there's none or hc fails.
 * @param {string} text
 */
export async function handOff(text) {
  const agent = currentAgent();
  if (!agent) throw new Error("No agent in this space. Start one, then send again.");
  const r = await hc(["send", agent.address, text]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "hc send failed");
  notify({ title: `Sent to ${agentName(agent)}`, body: `${agent.space_name} › ${agent.tab_name}`, level: "success", timeout: 4000 });
  return agent;
}
