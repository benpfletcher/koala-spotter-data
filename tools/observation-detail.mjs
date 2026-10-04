// Evidence-based national classification. Source wording remains available beside the derived type.
const METHODS = new Map(Object.entries({
  'seen':'Observed', 'seen and heard':'Observed and Heard call', 'photograph':'Camera',
  'spotlighted':'Observed', 'spotlight':'Observed', 'spotlighting':'Observed', 'spotlighting on foot':'Observed',
  'observed-no method stated':'Observed', 'observed-remote camera':'Camera',
  'camera - surveillance/remote':'Camera', 'camera trapping':'Camera', 'remote sensing camera image':'Camera',
  'thermal infrared image':'Camera', 'heard':'Heard call', 'sign-heard':'Heard call',
  'audio recording':'Acoustic recording', 'scat':'Scat', 'sign-dropping':'Scat',
  'tracks':'Tracks, scratchings', 'marks':'Tracks, scratchings',
  'signs (tracks, scats, nest etc)':'Signs', 'hair':'Hair, feathers or skin',
  'skeletal':'Bone, teeth or shell', 'remains':'Bone, teeth or shell',
  'road kill':'Road kill', 'observed-roadkill':'Road kill', 'dead':'Dead',
  'euthanased':'Dead', 'euthanised':'Dead', 'euthanized':'Dead', 'handled (ie captured)':'Caught', 'trapped':'Trapped or netted',
}));
export const clean = v => typeof v === 'string' && v.trim() && !/^(unknown|not supplied|withheld|null|n\/a)$/i.test(v.trim()) ? v.trim() : null;
export function observationType(o, title = '') {
  if (/^(B4C Road Kill Map|Roadkill)$/i.test(title.trim())) return 'Road kill';
  const method = clean(o.identification_method) || clean(o.samplingProtocol);
  const type = METHODS.get((method || '').toLowerCase());
  const notes = (clean(o.occurrenceRemarks) || '').replace(/\s+/g, ' ').trim();
  // Only unambiguous source statements, not broad keyword matching (e.g. 'dead tree').
  if (/^(?:Road[- ]?kill|Road[- ]?killed(?: (?:male|female))?)\.?$/i.test(notes) || /^Road-killed on [^?!]+\.$/i.test(notes) || /^Deceased\. Roadkill\.; ID = /i.test(notes)) return 'Road kill';
  if (/^Post mortem examination of dead wild koala \(euthanased or died\)$/i.test(notes) || /^(?:Dead|Deceased)\.?$/i.test(notes) || /^(?:One |A )?(?:deceased|dead) (?:adult |juvenile )?(?:male |female )?koala(?:[ .;,]|$)/i.test(notes) || /^What: Koala deceased beside /i.test(notes)) return 'Dead';
  if (type) return type;
  if (/^Moggill Koala Hospital Database$/i.test(o.project_name || o.datasetName || '')) return 'Wildlife hospital record';
  return 'Record';
}
export function safeURL(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; } catch { return null; }
}
// Label a photo's rights as the source publishes them. Returns null unless it is a recognised Creative Commons licence.
const CC_LABEL = { by: 'CC BY', 'by-sa': 'CC BY-SA', 'by-nc': 'CC BY-NC', 'by-nc-sa': 'CC BY-NC-SA', 'by-nd': 'CC BY-ND', 'by-nc-nd': 'CC BY-NC-ND' };
export function photoLicense(value) {
  const s = String(value || '').trim().toLowerCase();
  if (/^cc0(?:[- ]1\.0)?$/.test(s)) return 'CC0';
  const short = /^cc[- ](by(?:[- ](?:nc|sa|nd)){0,2})(?:[- ][1-4]\.0)?$/.exec(s);
  if (short) return CC_LABEL[short[1].replace(/ /g, '-')] || null;
  // Some providers spell the licence out: "Creative Commons Attribution 3.0".
  if (/^creative commons attribution\b/.test(s)) return CC_LABEL['by' + (/non-?commercial/.test(s) ? '-nc' : '') + (/share-?alike/.test(s) ? '-sa' : /no-?deriv/.test(s) ? '-nd' : '')] || null;
  try {
    const u = new URL(s);
    if (!['http:', 'https:'].includes(u.protocol) || !/^(www\.)?creativecommons\.org$/.test(u.hostname)) return null;
    if (/^\/publicdomain\/zero\/1\.0(?:\/|$)/.test(u.pathname)) return 'CC0';
    const m = /^\/licenses\/(by(?:-(?:nc|sa|nd)){0,2})\/[1-4]\.0(?:\/|$)/.exec(u.pathname);
    return m ? CC_LABEL[m[1]] || null : null;
  } catch { return null; }
}
export function nationalDetail(o, title) {
  // Keep every published photo. Rights are shown as the source states them, never upgraded to a licence it did not give.
  const photos = (o.media || []).filter(m => m.type === 'StillImage').flatMap(m => {
    const url = safeURL(m.identifier), cc = photoLicense(m.license), creator = clean(m.creator) || clean(m.rightsHolder);
    if (!url) return [];
    const ccUrl = cc && /^https?:\/\/(www\.)?creativecommons\.org\//i.test(m.license || '') ? m.license.replace(/^http:/i, 'https:') : null;
    return [{ url, license: cc || (clean(m.license) ? 'All rights reserved' : 'Licence not stated'), licenseUrl: ccUrl, creator: creator || 'Not supplied' }];
  });
  const notes = [...new Set([clean(o.occurrenceRemarks), clean(o.eventRemarks)].filter(Boolean))].join('\n');
  return Object.fromEntries(Object.entries({
    version: 1, datasetKey: o.datasetKey, occurrenceId: clean(o.occurrenceID), catalogNumber: clean(o.catalogNumber),
    uri: `https://www.gbif.org/occurrence/${o.key}`, project: clean(o.datasetName) && o.datasetName !== title ? clean(o.datasetName) : null,
    method: clean(o.samplingProtocol), sex: clean(o.sex), lifeStage: clean(o.lifeStage), behavior: clean(o.behavior),
    locality: clean(o.locality), notes: notes || null, recordStatus: clean(o.identificationVerificationStatus),
    photos: photos.length ? photos : null,
  }).filter(([,v]) => v != null));
}
