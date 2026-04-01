'use strict';

const llm = require('./connectors/llm');

// Default thresholds per persona. 0=show everything, 1=tangential+relevant, 2=directly relevant only.
const DEFAULT_THRESHOLDS = {
  engineering: 1,
  product: 2,
  design: 2,
  strategy: 1,
  unified: 0,
};

/**
 * Build the scoring system prompt dynamically from active personas.
 * @param {Array<{id: string, description: string}>} personas
 * @returns {string}
 */
function buildScoringPrompt(personas) {
  const personaDefs = personas
    .map(p => `- ${p.id}: ${p.description}`)
    .join('\n');

  const exampleKeys = personas.map(p => `"${p.id}":0`).join(',');

  return `You score journal entries and signals for relevance to this team's personas.
Score each item 0-2 for each persona:
- 0 = not relevant to this persona
- 1 = tangentially relevant (context, not action)
- 2 = directly relevant (this persona should see this)

Personas:
${personaDefs}

Return ONLY a JSON array. No explanation. Example:
[{"id":0,${exampleKeys}},{"id":1,${exampleKeys}}]`;
}

/**
 * Split content on section separators and number items.
 * @param {string} content
 * @param {number} startId - Starting item ID
 * @returns {{ items: string[], labeled: string }}
 */
function splitAndLabel(content, startId) {
  if (!content || !content.trim()) return { items: [], labeled: '' };
  const items = content.split('\n\n---\n\n').filter(s => s.trim());
  const labeled = items
    .map((item, i) => `[ITEM ${startId + i}]\n${item}`)
    .join('\n\n');
  return { items, labeled };
}

/**
 * Score signal and journal items for persona relevance using a single LLM call.
 * @param {string} signalContent - Raw signal content (sections separated by \n\n---\n\n)
 * @param {string} journalContent - Raw journal content (sections separated by \n\n---\n\n)
 * @param {Array<{id: string, description: string}>} personas - Active personas
 * @param {Object} llmConfig - LLM config for the scoring call
 * @returns {Promise<Array<{id: number, [personaId]: number}>|null>} Scores array or null on failure
 */
// Maximum characters to send to the scoring LLM in a single call.
// Beyond this, scoring is skipped and budget truncation handles content selection.
const SCORE_MAX_CHARS = 40000;

async function scoreItems(signalContent, journalContent, personas, llmConfig) {
  const signalResult = splitAndLabel(signalContent, 0);
  const journalResult = splitAndLabel(journalContent, signalResult.items.length);

  const totalItems = signalResult.items.length + journalResult.items.length;
  if (totalItems === 0) return null;

  // Skip scoring if content is too large for a reliable single LLM call.
  // The token budget step will handle content selection without scoring.
  const totalChars = (signalResult.labeled || '').length + (journalResult.labeled || '').length;
  if (totalChars > SCORE_MAX_CHARS) return null;

  const systemPrompt = buildScoringPrompt(personas);

  const userParts = [];
  if (signalResult.labeled) {
    userParts.push('## Signals\n\n' + signalResult.labeled);
  }
  if (journalResult.labeled) {
    userParts.push('## Journals\n\n' + journalResult.labeled);
  }
  const userContent = userParts.join('\n\n---\n\n');

  const config = {
    ...llmConfig,
    _personaId: 'scoring',
    _callType: 'scoring',
    max_tokens: Math.max(256, totalItems * 80),
  };

  try {
    const response = await llm.call(config, systemPrompt, userContent);
    let jsonStr = response.trim();
    // Strip markdown fences if present (reuse pattern from content-store.js)
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    const scores = JSON.parse(jsonStr);
    if (!Array.isArray(scores)) return null;
    return scores;
  } catch {
    // Graceful fallback: caller passes everything through
    return null;
  }
}

/**
 * Filter content sections based on persona relevance scores.
 * @param {string} signalContent - Raw signal content
 * @param {string} journalContent - Raw journal content
 * @param {Array<{id: number}>} scores - Scoring results from scoreItems
 * @param {string} personaId - Persona to filter for
 * @param {number} threshold - Minimum score to include (0, 1, or 2)
 * @param {string[]} allPersonaIds - All active persona IDs (for unified union logic)
 * @returns {{ signals: string, journals: string }}
 */
function filterForPersona(signalContent, journalContent, scores, personaId, threshold, allPersonaIds) {
  const signalItems = (signalContent && signalContent.trim())
    ? signalContent.split('\n\n---\n\n').filter(s => s.trim())
    : [];
  const journalItems = (journalContent && journalContent.trim())
    ? journalContent.split('\n\n---\n\n').filter(s => s.trim())
    : [];

  function itemPasses(itemIndex) {
    const score = scores.find(s => s.id === itemIndex);
    if (!score) return true; // If no score for this item, include it (safe default)

    if (personaId === 'unified') {
      // Union: passes if ANY persona scores >= their threshold
      return allPersonaIds.some(pid => {
        const pidThreshold = DEFAULT_THRESHOLDS[pid] ?? 1;
        return (score[pid] ?? 0) >= pidThreshold;
      });
    }

    return (score[personaId] ?? 0) >= threshold;
  }

  const filteredSignals = signalItems
    .filter((_, i) => itemPasses(i))
    .join('\n\n---\n\n');

  const signalCount = signalItems.length;
  const filteredJournals = journalItems
    .filter((_, i) => itemPasses(signalCount + i))
    .join('\n\n---\n\n');

  return { signals: filteredSignals, journals: filteredJournals };
}

/**
 * Build per-member mention data for a digest persona.
 * Counts how many items scored 2 (directly relevant) for each member's personas.
 *
 * @param {Array<{id: number, [personaId]: number}>} scores - Scoring results
 * @param {Array<{name: string, slack_user_id?: string, personas?: string[]}>} members - Team members
 * @param {string} digestPersonaId - The persona this digest is for
 * @returns {Array<{name: string, slackId: string, count: number}>} Members to mention, sorted by count desc
 */
function buildMentions(scores, members, digestPersonaId) {
  if (!scores || !members || members.length === 0) return [];

  const MENTION_THRESHOLD = 2; // Only mention for directly relevant items
  const mentions = [];

  for (const member of members) {
    if (!member.slack_user_id) continue;
    const memberPersonas = member.personas || [];

    // For unified digest: check all of the member's personas
    // For persona-specific digest: only mention if member has that persona
    const relevantPersonas = digestPersonaId === 'unified'
      ? memberPersonas
      : memberPersonas.filter(p => p === digestPersonaId);

    if (relevantPersonas.length === 0) continue;

    // Count items that scored >= MENTION_THRESHOLD for any of the member's relevant personas
    let count = 0;
    for (const score of scores) {
      const isRelevant = relevantPersonas.some(p => (score[p] ?? 0) >= MENTION_THRESHOLD);
      if (isRelevant) count++;
    }

    if (count > 0) {
      mentions.push({
        name: member.name || 'unknown',
        slackId: member.slack_user_id,
        count,
      });
    }
  }

  return mentions.sort((a, b) => b.count - a.count);
}

/**
 * Format mentions into a Slack mrkdwn message for thread reply.
 * @param {Array<{name: string, slackId: string, count: number}>} mentions
 * @returns {string|null} Formatted message or null if no mentions
 */
function formatMentionsMessage(mentions) {
  if (!mentions || mentions.length === 0) return null;

  const lines = mentions.map(m => {
    const items = m.count === 1 ? '1 item' : `${m.count} items`;
    return `<@${m.slackId}> — ${items} directly relevant to you`;
  });

  return `:bell: *Heads up*\n${lines.join('\n')}`;
}

module.exports = {
  scoreItems,
  filterForPersona,
  buildMentions,
  formatMentionsMessage,
  DEFAULT_THRESHOLDS,
  // Exported for testing
  buildScoringPrompt,
  splitAndLabel,
};
