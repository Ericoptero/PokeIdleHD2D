/**
 * validation.js — a memoized wrapper around `@/terrain/validate.js`'s `validateMap`, plus the
 * one issue-row DOM builder the bottom-panel tab and the drawer both use.
 *
 * `validateMap` runs 19 checks including a BFS over the whole grid (`reachableFrom`) — running
 * it fresh on every keystroke (the toolbar badge used to) is real, measurable waste on a
 * 64×64 map. Memoized on a revision counter the caller bumps once per meaningful edit.
 */

import { h } from '@/ui/dom/el.js';
import { validateMap } from '@/terrain/validate.js';
import { serializeDocument } from './state.js';
import { loadedCatalogs, peekSpeciesNames } from './catalog.js';
import { icon } from './icons.js';

let cache = null; // { rev, doc, result }

/** @param {object} doc @param {{force?:boolean}} [opts] @returns {{errors,warnings,infos,skipped,stats}} */
export function runValidation(doc, { force = false } = {}) {
  if (!doc) return { errors: [], warnings: [], infos: [], skipped: [], stats: {} };
  const rev = doc._rev ?? 0;
  if (!force && cache && cache.doc === doc && cache.rev === rev) return cache.result;
  const t0 = performance.now();
  const result = validateMap(serializeDocument(doc), validationEnv());
  result.ms = performance.now() - t0;
  cache = { rev, doc, result };
  return result;
}

/** Invalidates the cache without recomputing — call after any doc mutation, cheap. */
export function invalidateValidation() { cache = null; }

/**
 * The context `validateMap` needs for its non-pure checks. `species` un-skips
 * `spawn-point-species` once the snapshot has loaded (`peekSpeciesNames`, `null` until then,
 * in which case the key is omitted so the check reports `skipped` rather than passing on an
 * empty set); `catalogs`/`maps` un-skip the catalog- and cross-map-dependent checks.
 */
export function validationEnv(extra = {}) {
  const species = peekSpeciesNames();
  return { catalogs: loadedCatalogs(), maps: {}, ...(species ? { species } : {}), ...extra };
}

const SEVERITY_ICON = { erro: 'circle-alert', aviso: 'triangle-alert', info: 'info' };
const SEVERITY_LABEL = { err: 'erro', warn: 'aviso', info: 'info' };

/** @param {object} issue @param {{onFocus:(cx:number,cz:number)=>void}} opts */
export function issueRow(issue, { onFocus }) {
  const cls = issue.severity === 'error' ? 'err' : issue.severity === 'warn' ? 'warn' : 'info';
  const at = issue.at?.cx != null ? `${issue.at.cx},${issue.at.cz}` : (issue.at?.marker ?? '');
  return h('div', { class: `ms-issue-row ms-issue-row--${cls}` }, [
    h('span', { class: `ms-issue-icon ms-issue-icon--${cls}` }, [icon(SEVERITY_ICON[SEVERITY_LABEL[cls]], { size: 14 })]),
    h('div', { class: 'ms-issue-text' }, [
      h('span', { class: 'ms-issue-msg' }, issue.message),
      issue.hint ? h('span', { class: 'ms-issue-hint' }, issue.hint) : null,
    ]),
    at ? h('span', { class: 'ms-issue-at' }, at) : null,
    issue.at?.cx != null
      ? h('button', { class: 'ms-iconbtn ms-iconbtn--ghost', title: 'Focar', onClick: () => onFocus(issue.at.cx, issue.at.cz) }, [icon('crosshair', { size: 13 })])
      : null,
  ].filter(Boolean));
}
