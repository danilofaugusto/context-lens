function median(arr) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function computePairsAndResiduals(parsed) {
  const steps = parsed?.steps || [];
  const requests = (parsed?.requests || []).filter(r => r.context > 0);
  const userInputs = parsed?.userInputs || [];

  const checkpoints = new Set(
    steps.filter(s => s.type === 'CHECKPOINT').map(s => s.step_index)
  );

  const pairs = [];
  for (const u of userInputs) {
    if (u.step === 0) continue;

    const prevList = requests.filter(r => r.step < u.step);
    if (prevList.length === 0) continue;
    const prev = prevList[prevList.length - 1];

    const actualList = requests.filter(r => r.step > u.step);
    if (actualList.length === 0) continue;
    const actual = actualList[0];

    // Check if checkpoint occurred between prev.step and actual.step
    let hasCp = false;
    for (const cp of checkpoints) {
      if (cp >= prev.step && cp <= actual.step) {
        hasCp = true;
        break;
      }
    }
    if (hasCp) continue;
    if (actual.context < prev.context) continue;

    pairs.push({ u, prev, actual });
  }

  const results = [];
  const residuals = [];

  for (let k = 0; k < pairs.length; k++) {
    const { u, prev, actual } = pairs[k];

    const priorUserInputs = userInputs.filter(item => item.step < u.step);
    const priorTokens = priorUserInputs.map(item => Math.ceil(item.chars / 4));
    const priorUserTokens = priorTokens.length > 0 ? median(priorTokens) : 50;

    const naive_k = prev.context + prev.output + priorUserTokens;
    const pastErrors = residuals.slice(0, k);
    const bias_k = k >= 3 ? median(pastErrors) : 0;
    const forecast_k = Math.round(naive_k + bias_k);

    residuals.push(actual.context - naive_k);
    const errorPct_k = (Math.abs(actual.context - forecast_k) / actual.context) * 100;

    results.push({
      forecast: forecast_k,
      actual: actual.context,
      delta: actual.context - forecast_k,
      errorPct: errorPct_k
    });
  }

  return { pairs, results, residuals };
}

export function backtest(parsed) {
  const { pairs, results } = computePairsAndResiduals(parsed);
  if (pairs.length === 0 || results.length === 0) {
    return {
      forecast: null,
      actual: null,
      delta: null,
      errorPct: null,
      mape: null,
      samples: 0
    };
  }

  const lastCheckpoint = parsed?.lastCheckpoint ?? -1;
  const lastUser = parsed?.userInputs?.[parsed.userInputs.length - 1];

  let validLastResult = results[results.length - 1];
  let validLastPair = pairs[pairs.length - 1];

  // If a compaction occurred and the current active user turn is post-checkpoint,
  // do not show stale pre-compaction forecast/actual in the card.
  if (lastCheckpoint >= 0 && lastUser && lastUser.step > lastCheckpoint) {
    if (!validLastPair || validLastPair.u.step < lastCheckpoint) {
      validLastResult = null;
    }
  }

  const allErrors = results.map(r => r.errorPct);
  const mape = mean(allErrors);

  return {
    forecast: validLastResult ? validLastResult.forecast : null,
    actual: validLastResult ? validLastResult.actual : null,
    delta: validLastResult ? validLastResult.delta : null,
    errorPct: validLastResult ? Number(validLastResult.errorPct.toFixed(1)) : null,
    mape: Number(mape.toFixed(1)),
    samples: pairs.length
  };
}

export function forecastNext(parsed) {
  const requests = (parsed?.requests || []).filter(r => r.context > 0);
  if (requests.length === 0) {
    return { next: null, delta: null };
  }

  const lastReq = requests[requests.length - 1];
  const { residuals } = computePairsAndResiduals(parsed);

  const userTokens = (parsed?.userInputs || []).map(u => Math.ceil(u.chars / 4));
  const userMedian = userTokens.length > 0 ? median(userTokens) : 50;
  const bias = residuals.length >= 3 ? median(residuals) : 0;

  const naive = lastReq.context + lastReq.output + userMedian;
  const next = Math.round(naive + bias);
  const delta = next - lastReq.context;

  return { next, delta };
}
