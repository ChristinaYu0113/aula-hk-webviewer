// AULA's survey labels and Gaussian patch IDs belong to separate datasets.
// Use explicit pairs reviewed in the exported survey frame.
const aulaPairs = [
  [1, 1], // Folded auditorium roof
  // These terrain patches share the survey ground footprint in X/Z and have
  // a consistent vertical offset in the supplied registration. Their outer
  // coverage extends beyond the survey patch.
  [41, 73],
  [41, 75],
  [41, 76],
];

export function isPairedMode(mode) {
  return mode === 'spc' || mode === 's3dgs';
}

export function otherPatchMode(mode) {
  return mode === 'spc' ? 's3dgs' : 'spc';
}

export function indexAulaMatches(spc, s3dgs) {
  const surveyParts = new Map(spc.parts.map(part => [part.id, part]));
  const scanParts = new Map(s3dgs.parts.map(part => [part.id, part]));
  const matches = { spc: new Map(), s3dgs: new Map() };

  for (const [surveyId, scanId] of aulaPairs) {
    const survey = surveyParts.get(surveyId);
    const scan = scanParts.get(scanId);
    if (!survey || !scan) continue;
    if (!matches.spc.has(surveyId)) matches.spc.set(surveyId, []);
    if (!matches.s3dgs.has(scanId)) matches.s3dgs.set(scanId, []);
    matches.spc.get(surveyId).push(scan);
    matches.s3dgs.get(scanId).push(survey);
  }
  return matches;
}
