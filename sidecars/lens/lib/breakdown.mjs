export function scaleItemsToTotal(items, targetTotal) {
  if (!items || items.length === 0) return [];
  const target = Math.max(0, Math.round(targetTotal || 0));
  if (target === 0) {
    return items.map(it => ({ ...it, tokens: 0 }));
  }

  const rawSum = items.reduce((sum, it) => sum + (Number.isFinite(it.tokens) ? Math.max(0, it.tokens) : 0), 0);

  if (rawSum === 0) {
    const base = Math.floor(target / items.length);
    const rem = target - (base * items.length);
    return items.map((it, idx) => ({
      ...it,
      tokens: base + (idx < rem ? 1 : 0)
    }));
  }

  const shares = items.map((it, idx) => {
    const raw = Number.isFinite(it.tokens) ? Math.max(0, it.tokens) : 0;
    const floatVal = (raw / rawSum) * target;
    const floorVal = Math.floor(floatVal);
    const fraction = floatVal - floorVal;
    return { idx, floorVal, fraction };
  });

  const sumFloor = shares.reduce((acc, s) => acc + s.floorVal, 0);
  const remainder = target - sumFloor;

  const sortedByFraction = [...shares].sort((a, b) => {
    if (b.fraction !== a.fraction) return b.fraction - a.fraction;
    return a.idx - b.idx;
  });

  const allocated = new Array(items.length).fill(0);
  for (const s of shares) {
    allocated[s.idx] = s.floorVal;
  }

  for (let i = 0; i < remainder; i++) {
    const pick = sortedByFraction[i % sortedByFraction.length];
    allocated[pick.idx] += 1;
  }

  return items.map((it, idx) => ({
    ...it,
    tokens: allocated[idx]
  }));
}

export function computeBreakdown(parsed, scanned) {
  const warnings = [];
  const validRequests = (parsed?.requests || []).filter(r => r.context > 0);
  if (validRequests.length === 0) {
    return {
      total: null,
      categories: [],
      warnings: ['Waiting for first model response telemetry']
    };
  }

  const lastReq = validRequests[validRequests.length - 1];
  const total = lastReq.context;
  const firstReq = validRequests[0];
  const firstUserChars = parsed.userInputs?.[0]?.chars ?? 0;
  const measuredFloor = Math.min(total, Math.max(firstReq.context - Math.ceil(firstUserChars / 4), 1000));

  const rulesList = scanned?.rules || [];
  const skillsList = scanned?.skills || [];
  const agentsList = scanned?.agents || [];

  const rulesRaw = rulesList.reduce((acc, r) => acc + (r.tokens || 0), 0);
  const skillsRaw = skillsList.reduce((acc, s) => acc + (s.tokens || 0), 0);
  const agentsRaw = agentsList.reduce((acc, a) => acc + (a.tokens || 0), 0);
  const staticTotalRaw = rulesRaw + skillsRaw + agentsRaw;

  let rulesTokens = rulesRaw;
  let skillsTokens = skillsRaw;
  let agentsTokens = agentsRaw;

  if (measuredFloor >= 4000 && staticTotalRaw > (measuredFloor - 2500)) {
    const avail = measuredFloor - 2500;
    const staticScaled = scaleItemsToTotal(
      [
        { id: 'rules', tokens: rulesRaw },
        { id: 'skills', tokens: skillsRaw },
        { id: 'agents', tokens: agentsRaw }
      ],
      avail
    );
    rulesTokens = staticScaled.find(s => s.id === 'rules')?.tokens || 0;
    skillsTokens = staticScaled.find(s => s.id === 'skills')?.tokens || 0;
    agentsTokens = staticScaled.find(s => s.id === 'agents')?.tokens || 0;
    warnings.push('Static file estimates scaled to fit measured first-turn floor');
  } else if (measuredFloor < 4000 && staticTotalRaw > measuredFloor) {
    const avail = Math.floor(measuredFloor * 0.6);
    const staticScaled = scaleItemsToTotal(
      [
        { id: 'rules', tokens: rulesRaw },
        { id: 'skills', tokens: skillsRaw },
        { id: 'agents', tokens: agentsRaw }
      ],
      avail
    );
    rulesTokens = staticScaled.find(s => s.id === 'rules')?.tokens || 0;
    skillsTokens = staticScaled.find(s => s.id === 'skills')?.tokens || 0;
    agentsTokens = staticScaled.find(s => s.id === 'agents')?.tokens || 0;
    warnings.push('Static file estimates scaled to fit measured first-turn floor');
  }

  const systemTokens = Math.max(0, measuredFloor - (rulesTokens + skillsTokens + agentsTokens));
  const dynamicTokens = Math.max(0, total - measuredFloor);

  const lastCp = parsed.lastCheckpoint ?? -1;
  const checkpointChars = lastCp >= 0 ? (parsed.checkpointChars || 0) : 0;

  let userChars = 0;
  for (const u of parsed.userInputs || []) {
    if (u.step > lastCp) userChars += u.chars || 0;
  }

  let assistantChars = 0;
  for (const r of parsed.requests || []) {
    if (r.step > lastCp) {
      assistantChars += (r.contentChars || 0) + (r.argsChars || 0);
    }
  }

  const activeToolCalls = (parsed.toolCalls || []).filter(tc => tc.step > lastCp);
  const toolOutputChars = activeToolCalls.reduce((acc, tc) => acc + (tc.outputChars || 0), 0);

  const msgChars = checkpointChars + userChars + assistantChars;
  const totalDynamicChars = msgChars + toolOutputChars;

  let messagesTokens = 0;
  let toolsTokens = 0;
  if (dynamicTokens > 0) {
    if (totalDynamicChars > 0) {
      messagesTokens = Math.round(dynamicTokens * (msgChars / totalDynamicChars));
      toolsTokens = dynamicTokens - messagesTokens;
    } else {
      messagesTokens = Math.round(dynamicTokens * 0.5);
      toolsTokens = dynamicTokens - messagesTokens;
    }
  }

  const msgItems = [];
  if (lastCp >= 0 && checkpointChars > 0) {
    msgItems.push({
      label: 'Compaction Summary',
      hint: 'Context summary after compaction checkpoint',
      tokens: Math.ceil(checkpointChars / 4)
    });
  }
  msgItems.push(
    {
      label: 'User Prompts',
      hint: 'User instructions and prompt messages',
      tokens: Math.ceil(userChars / 4)
    },
    {
      label: 'Assistant Responses',
      hint: 'Model thought, text and tool call arguments',
      tokens: Math.ceil(assistantChars / 4)
    }
  );

  const activeToolCallsNewestFirst = [...activeToolCalls].reverse().map(tc => ({
    label: `${tc.name}: ${tc.summary}`,
    hint: `${tc.outputChars.toLocaleString('en-US')} output chars`,
    tokens: Math.ceil(((tc.outputChars || 0) + (tc.argsChars || 0)) / 4) || 1
  }));

  const categories = [
    {
      id: 'system',
      label: 'System Prompt & Tool Schemas',
      color: 'blue',
      kind: 'residual',
      tokens: systemTokens,
      items: []
    },
    {
      id: 'rules',
      label: 'Rules & Memory Files',
      color: 'emerald',
      kind: 'estimate',
      tokens: rulesTokens,
      items: scaleItemsToTotal(rulesList, rulesTokens)
    },
    {
      id: 'skills',
      label: 'Skills Index',
      color: 'amber',
      kind: 'estimate',
      tokens: skillsTokens,
      items: scaleItemsToTotal(skillsList, skillsTokens)
    }
  ];

  if (agentsTokens > 0 || agentsList.length > 0) {
    categories.push({
      id: 'agents',
      label: 'Custom Agents',
      color: 'cyan',
      kind: 'estimate',
      tokens: agentsTokens,
      items: scaleItemsToTotal(agentsList, agentsTokens)
    });
  }

  categories.push(
    {
      id: 'messages',
      label: 'Conversation Messages',
      color: 'indigo',
      kind: 'estimate',
      tokens: messagesTokens,
      items: scaleItemsToTotal(msgItems, messagesTokens)
    },
    {
      id: 'tools',
      label: 'Tool Outputs',
      color: 'purple',
      kind: 'estimate',
      tokens: toolsTokens,
      items: scaleItemsToTotal(activeToolCallsNewestFirst, toolsTokens)
    }
  );

  return {
    total,
    categories,
    warnings
  };
}
