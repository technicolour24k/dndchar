const state = {
  systems: [],
  templatesBySystem: {},
  referenceOptionsBySystem: {},
  equipmentCatalogBySystem: {},
  characters: [],
  current: null,
  view: 'roster',
  activeTab: 'features',
  versions: [],
  autosaveTimer: null,
  isSaving: false,
  isRendering: false,
  dirty: false,
  lastSavedHash: '',
};

const ABILITIES = [
  { key: 'str', short: 'STR', label: 'Strength' },
  { key: 'dex', short: 'DEX', label: 'Dexterity' },
  { key: 'int', short: 'INT', label: 'Intelligence' },
  { key: 'wis', short: 'WIS', label: 'Wisdom' },
  { key: 'con', short: 'CON', label: 'Constitution' },
  { key: 'cha', short: 'CHA', label: 'Charisma' },
];

const CLASS_OPTIONS = [
  'Barbarian', 'Bard', 'Cleric', 'Druid', 'Fighter', 'Monk',
  'Paladin', 'Ranger', 'Rogue', 'Sorcerer', 'Warlock', 'Wizard',
];
const REFERENCE_FALLBACK = {
  race: ['Dragonborn', 'Dwarf', 'Elf', 'Gnome', 'Half-Elf', 'Halfling', 'Half-Orc', 'Human', 'Tiefling'],
  background: ['Acolyte', 'Charlatan', 'Criminal', 'Entertainer', 'Folk Hero', 'Guild Artisan', 'Hermit', 'Noble', 'Outlander', 'Sage', 'Sailor', 'Soldier', 'Urchin'],
};

const BLOCK_FIELDS = [
  { id: 'personality_traits', title: 'Personality Traits', inputId: 'block_personality_traits' },
  { id: 'ideals', title: 'Ideals', inputId: 'block_ideals' },
  { id: 'bonds', title: 'Bonds', inputId: 'block_bonds' },
  { id: 'flaws', title: 'Flaws', inputId: 'block_flaws' },
  { id: 'attacks', title: 'Attacks & Spellcasting', inputId: 'block_attacks' },
  { id: 'inventory', title: 'Inventory / Equipment', inputId: 'block_inventory' },
  { id: 'spellcasting', title: 'Spellcasting', inputId: 'block_spellcasting' },
];

const EQUIPMENT_TYPES = ['weapon', 'armor', 'shield', 'wondrous', 'gear', 'consumable'];
const ATTACK_ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

const HIDDEN_VAR_KEYS = new Set([
  'race',
  'background',
  'total_level',
  'death_successes',
  'death_failures',
]);

const $ = (id) => document.getElementById(id);

function setStatus(msg) {
  const el = $('status');
  if (el) el.textContent = msg;
}

function setAutosaveState(msg, tone = '') {
  const el = $('autosaveState');
  if (!el) return;
  el.textContent = `Autosave: ${msg}`;
  el.className = `autosave-state ${tone}`.trim();
}

function setAppTitle(name = '') {
  const clean = String(name || '').trim();
  const title = clean ? `TavernSheet - ${clean}` : 'TavernSheet';
  const el = $('appTitle');
  if (el) el.textContent = clean || 'TavernSheet';
  document.title = title;
}

async function apiGet(action, params = {}) {
  const qs = new URLSearchParams({ action, ...params });
  const res = await fetch(`api.php?${qs.toString()}`);
  return res.json();
}

async function apiPost(action, body) {
  const res = await fetch(`api.php?action=${encodeURIComponent(action)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function tokenize(expr) {
  const out = [];
  const re = /\s*([A-Za-z_][A-Za-z0-9_]*|\d+\.\d+|\d+|[-+*/(),])\s*/g;
  let m;
  while ((m = re.exec(expr)) !== null) out.push(m[1]);
  return out;
}

function evalFormula(expr, varsMap) {
  if (!expr || !expr.trim()) return 0;
  const tokens = tokenize(expr);
  const output = [];
  const ops = [];
  const prec = { '+': 1, '-': 1, '*': 2, '/': 2 };
  const funcs = new Set(['floor', 'ceil', 'round', 'abs']);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^\d/.test(t)) {
      output.push({ type: 'num', v: Number(t) });
    } else if (/^[A-Za-z_]/.test(t)) {
      if (funcs.has(t)) ops.push(t);
      else output.push({ type: 'num', v: toNum(varsMap[t]) });
    } else if (t in prec) {
      while (ops.length) {
        const top = ops[ops.length - 1];
        if (top in prec && prec[top] >= prec[t]) output.push({ type: 'op', v: ops.pop() });
        else break;
      }
      ops.push(t);
    } else if (t === '(') {
      ops.push(t);
    } else if (t === ')') {
      while (ops.length && ops[ops.length - 1] !== '(') {
        output.push({ type: 'op', v: ops.pop() });
      }
      ops.pop();
      if (ops.length && funcs.has(ops[ops.length - 1])) output.push({ type: 'fn', v: ops.pop() });
    } else if (t === ',') {
      while (ops.length && ops[ops.length - 1] !== '(') {
        output.push({ type: 'op', v: ops.pop() });
      }
    }
  }

  while (ops.length) {
    const top = ops.pop();
    if (top !== '(') output.push({ type: funcs.has(top) ? 'fn' : 'op', v: top });
  }

  const st = [];
  for (const it of output) {
    if (it.type === 'num') st.push(it.v);
    if (it.type === 'op') {
      const b = st.pop() ?? 0;
      const a = st.pop() ?? 0;
      if (it.v === '+') st.push(a + b);
      if (it.v === '-') st.push(a - b);
      if (it.v === '*') st.push(a * b);
      if (it.v === '/') st.push(b === 0 ? 0 : a / b);
    }
    if (it.type === 'fn') {
      const a = st.pop() ?? 0;
      if (it.v === 'floor') st.push(Math.floor(a));
      if (it.v === 'ceil') st.push(Math.ceil(a));
      if (it.v === 'round') st.push(Math.round(a));
      if (it.v === 'abs') st.push(Math.abs(a));
    }
  }

  return toNum(st.pop() ?? 0);
}

function evaluateSheet(sheet) {
  const vars = sheet.variables || [];
  const map = {};

  for (const v of vars) {
    map[v.key] = toNum(v.value);
  }

  for (let i = 0; i < 4; i++) {
    for (const v of vars) {
      if (v.formula && String(v.formula).trim()) {
        v.computed = evalFormula(v.formula, map);
      } else {
        v.computed = v.value;
      }
      map[v.key] = toNum(v.computed);
    }
  }

  return map;
}

function parseRoll(expr, varsMap) {
  const clean = (expr || '').trim();
  if (!clean) return { total: 0, detail: 'No expression.' };

  let expanded = clean.replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, (k) => {
    if (['d', 'floor', 'ceil', 'round', 'abs'].includes(k)) return k;
    return String(toNum(varsMap[k]));
  });

  const rolls = [];
  expanded = expanded.replace(/(\d*)d(\d+)/gi, (_, a, b) => {
    const count = Math.max(1, toNum(a || 1));
    const sides = Math.max(2, toNum(b));
    let sum = 0;
    const list = [];
    for (let i = 0; i < count; i++) {
      const r = 1 + Math.floor(Math.random() * sides);
      list.push(r);
      sum += r;
    }
    rolls.push(`${count}d${sides}=[${list.join(',')}]`);
    return String(sum);
  });

  const total = evalFormula(expanded, {});
  return { total, detail: `Input: ${clean}\nExpanded: ${expanded}\n${rolls.join('\n')}` };
}

function upsertVar(vars, key, label, value = 0, formula = '') {
  let row = vars.find((it) => it.key === key);
  if (!row) {
    row = { key, label, value, formula };
    vars.push(row);
  }
  return row;
}

function getVar(vars, key) {
  return vars.find((it) => it.key === key) || null;
}

function setNumericVar(character, key, label, value) {
  const row = upsertVar(character.sheet.variables, key, label, 0, '');
  row.value = toNum(value);
}

function setTextVar(character, key, label, value) {
  const row = upsertVar(character.sheet.variables, key, label, '', '');
  row.value = String(value ?? '');
}

function ensureBlock(character, id, title) {
  let block = (character.sheet.blocks || []).find((b) => b.id === id);
  if (!block) {
    block = { id, title, content: '' };
    character.sheet.blocks.push(block);
  }
  return block;
}

function isAdvancedVarKey(key) {
  return /_item_bonus$/.test(key || '') || /_equip_bonus$/.test(key || '') || key === 'ac_base' || key === 'ac_equip_bonus' || HIDDEN_VAR_KEYS.has(key || '');
}

function formatMod(n) {
  const v = toNum(n);
  return v >= 0 ? `+${v}` : String(v);
}

function formatDate(value) {
  if (!value) return 'Never';
  const d = new Date(String(value).replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function parseMeta(row) {
  if (row?.system_meta && typeof row.system_meta === 'object') return row.system_meta;
  try {
    return JSON.parse(row?.system_meta_json || '{}') || {};
  } catch {
    return {};
  }
}

function parseSheet(row) {
  if (row?.sheet && typeof row.sheet === 'object') return row.sheet;
  try {
    return JSON.parse(row?.sheet_json || '{}') || { variables: [], blocks: [], macros: [] };
  } catch {
    return { variables: [], blocks: [], macros: [] };
  }
}

function getCharacterSummary(row) {
  const meta = parseMeta(row);
  const sheet = parseSheet(row);
  const vars = Array.isArray(sheet.variables) ? sheet.variables : [];
  const classEntries = Array.isArray(meta.class_levels) && meta.class_levels.length
    ? meta.class_levels
    : [{ class_name: 'Adventurer', level: toNum(getVar(vars, 'level')?.value || 1) || 1 }];
  const level = classEntries.reduce((sum, it) => sum + toNum(it.level || 0), 0) || toNum(getVar(vars, 'level')?.value || 1);
  const hpCurrent = toNum(getVar(vars, 'hp_current')?.value || 0);
  const hpMax = toNum(getVar(vars, 'hp_max')?.value || 0);
  const classes = classEntries.map((it) => it.class_name).filter(Boolean).join(' / ') || 'Adventurer';
  const race = String(getVar(vars, 'race')?.value || '').trim();
  const background = String(getVar(vars, 'background')?.value || '').trim();
  return { classes, level, hpCurrent, hpMax, race, background };
}

function characterHash(character) {
  if (!character) return '';
  return JSON.stringify({
    name: character.name,
    system_key: character.system_key,
    template_id: character.template_id,
    system_meta: character.system_meta || {},
    sheet: character.sheet || {},
    equipment: getEquipmentEntries(character),
  });
}

function showView(name) {
  state.view = name;
  ['roster', 'sheet', 'history'].forEach((view) => {
    const el = $(`${view}View`);
    if (el) el.classList.toggle('is-hidden', view !== name);
  });
  const navRoster = $('navRosterBtn');
  if (navRoster) navRoster.classList.toggle('active', name === 'roster');
}

function setActiveTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.panel === tab);
  });
}

function renderRoster() {
  const wrap = $('characterRoster');
  if (!wrap) return;
  const query = String($('globalSearch')?.value || '').trim().toLowerCase();
  const sort = $('rosterSort')?.value || 'updated';
  let rows = [...state.characters];

  if (query) {
    rows = rows.filter((c) => {
      const summary = getCharacterSummary(c);
      return [c.name, c.system_key, summary.classes, summary.race, summary.background]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
  }

  rows.sort((a, b) => {
    if (sort === 'name') return String(a.name).localeCompare(String(b.name));
    if (sort === 'level') return getCharacterSummary(b).level - getCharacterSummary(a).level;
    return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
  });

  const count = $('rosterCount');
  if (count) count.textContent = `${rows.length} character${rows.length === 1 ? '' : 's'}`;
  wrap.innerHTML = '';

  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No characters match the current search.';
    wrap.appendChild(empty);
    return;
  }

  rows.forEach((c) => {
    const summary = getCharacterSummary(c);
    const row = document.createElement('article');
    row.className = 'character-row';

    const token = document.createElement('div');
    token.className = 'character-token';
    token.textContent = String(c.name || '?').slice(0, 2).toUpperCase();

    const main = document.createElement('div');
    main.className = 'character-main';
    const title = document.createElement('h3');
    title.textContent = c.name;
    const sub = document.createElement('p');
    sub.textContent = `${summary.race ? `${summary.race} - ` : ''}${summary.classes}`;
    main.append(title, sub);

    const stats = document.createElement('div');
    stats.className = 'character-row-stats';
    stats.innerHTML = `<span>Level <strong>${summary.level || 1}</strong></span><span>HP <strong>${summary.hpMax ? `${summary.hpCurrent} / ${summary.hpMax}` : 'n/a'}</strong></span><span>Updated <strong>${formatDate(c.updated_at)}</strong></span>`;

    const actions = document.createElement('div');
    actions.className = 'character-actions';
    const view = document.createElement('button');
    view.type = 'button';
    view.textContent = 'View';
    view.onclick = () => loadCharacter(c.id);
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = 'Edit';
    edit.onclick = () => loadCharacter(c.id);
    actions.append(view, edit);

    row.append(token, main, stats, actions);
    wrap.appendChild(row);
  });
}

function renderInventorySummary(character) {
  const wrap = $('inventorySummary');
  const count = $('inventoryCount');
  if (!wrap) return;
  const rows = getEquipmentEntries(character).filter((it) => it.name);
  if (count) count.textContent = `${rows.length} item${rows.length === 1 ? '' : 's'}`;
  wrap.innerHTML = '';
  rows.slice(0, 6).forEach((item) => {
    const el = document.createElement('div');
    el.className = 'inventory-pill';
    el.innerHTML = `<strong>${item.name}</strong><span>${item.category}${item.equipped ? ' - equipped' : ''}</span>`;
    wrap.appendChild(el);
  });
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'muted-note';
    empty.textContent = 'No equipment yet.';
    wrap.appendChild(empty);
  }
}

function renderVersionList(target, versions, compact = false) {
  const wrap = $(target);
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!versions.length) {
    const empty = document.createElement('div');
    empty.className = 'muted-note';
    empty.textContent = 'No versions yet.';
    wrap.appendChild(empty);
    return;
  }

  versions.forEach((v) => {
    const item = document.createElement('article');
    item.className = 'version-item';
    const label = document.createElement('div');
    label.innerHTML = `<strong>${v.label || v.version_source}</strong><span>${v.version_source} - ${formatDate(v.created_at)}</span>`;
    const actions = document.createElement('div');
    actions.className = 'version-actions';
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.textContent = compact ? 'Revert' : 'Restore';
    restore.onclick = () => restoreVersion(v.id);
    const duplicate = document.createElement('button');
    duplicate.type = 'button';
    duplicate.textContent = compact ? 'Copy' : 'Duplicate';
    duplicate.onclick = () => duplicateVersion(v.id);
    actions.append(restore, duplicate);
    item.append(label, actions);
    wrap.appendChild(item);
  });
}

function renderVersions() {
  const list = Array.isArray(state.versions) ? state.versions : [];
  const preview = list.slice(0, 3);
  const count = $('versionPreviewCount');
  if (count) count.textContent = `${list.length} entr${list.length === 1 ? 'y' : 'ies'}`;
  renderVersionList('latestVersions', preview, true);
  renderVersionList('fullVersionHistory', list, false);
  const sub = $('historySubtitle');
  if (sub && state.current) sub.textContent = `Restorable snapshots for ${state.current.name}.`;
}

async function refreshVersions() {
  if (!state.current?.id) {
    state.versions = [];
    renderVersions();
    return;
  }
  const res = await apiGet('character_versions', { character_id: state.current.id });
  state.versions = res.ok ? (res.versions || []) : [];
  renderVersions();
}

function prepareCurrentForSave() {
  const c = state.current;
  if (!c) return null;
  c.name = $('charName')?.value.trim() || c.name;
  c.system_meta = c.system_meta || {};
  c.system_meta.use_5e_helpers = !!$('charHelpers')?.checked;
  ensure5eHelperStructure(c);
  syncClassLevelTotals(c);
  applyEquipmentEffects(c);
  evaluateSheet(c.sheet);
  return c;
}

async function saveCurrentCharacter(source = 'manual', label = '', options = {}) {
  const c = prepareCurrentForSave();
  if (!c || state.isSaving) return null;
  state.isSaving = true;
  setAutosaveState(source === 'autosave' ? 'Saving' : 'Saving', 'saving');

  const payload = {
    id: c.id,
    name: c.name,
    system_key: c.system_key,
    template_id: c.template_id,
    system_meta: c.system_meta,
    sheet: c.sheet,
    equipment: getEquipmentEntries(c),
    save_source: source,
    snapshot_label: label,
  };
  if (Object.prototype.hasOwnProperty.call(options, 'create_version')) {
    payload.create_version = !!options.create_version;
  }

  const res = await apiPost('save_character', payload);
  state.isSaving = false;
  if (!res.ok) {
    setAutosaveState('Save failed', 'error');
    setStatus(res.error || 'Save failed');
    return null;
  }

  state.dirty = false;
  state.lastSavedHash = characterHash(c);
  await bootstrap();
  await refreshVersions();
  setAutosaveState(source === 'autosave' ? 'Autosaved' : 'Saved', 'saved');
  setStatus(source === 'autosave' ? 'Autosaved' : 'Character saved');
  return res;
}

function scheduleAutosave() {
  if (!state.current || state.isRendering) return;
  state.dirty = true;
  setAutosaveState('Unsaved', 'dirty');
  clearTimeout(state.autosaveTimer);
  state.autosaveTimer = setTimeout(async () => {
    if (!state.current || characterHash(prepareCurrentForSave()) === state.lastSavedHash) {
      state.dirty = false;
      setAutosaveState('Autosaved', 'saved');
      return;
    }
    await saveCurrentCharacter('autosave', 'Autosave');
  }, 1500);
}

function renderAbilities(character, map) {
  const wrap = $('abilityColumn');
  wrap.innerHTML = '';

  ABILITIES.forEach((ab) => {
    const baseKey = ab.key;
    const bonusKey = `${ab.key}_item_bonus`;
    const equipKey = `${ab.key}_equip_bonus`;
    const modKey = `${ab.key}_mod`;

    const baseRow = getVar(character.sheet.variables, baseKey);
    const bonusRow = getVar(character.sheet.variables, bonusKey);
    const equipRow = getVar(character.sheet.variables, equipKey);

    const card = document.createElement('div');
    card.className = 'ability-card';

    const name = document.createElement('div');
    name.className = 'ability-name';
    name.textContent = ab.short;

    const full = document.createElement('div');
    full.className = 'ability-full';
    full.textContent = ab.label;

    const total = document.createElement('div');
    total.className = 'ability-total';
    total.textContent = String(toNum(baseRow?.value ?? 10) + toNum(bonusRow?.value ?? 0) + toNum(equipRow?.value ?? 0));

    const scoreWrap = document.createElement('label');
    scoreWrap.className = 'ability-score';
    scoreWrap.textContent = 'Score';
    const scoreInput = document.createElement('input');
    scoreInput.type = 'number';
    scoreInput.value = String(toNum(baseRow?.value ?? 10));
    scoreInput.oninput = () => {
      setNumericVar(character, baseKey, ab.label, scoreInput.value);
      renderSheet();
    };
    scoreWrap.appendChild(scoreInput);

    const mod = document.createElement('div');
    mod.className = 'ability-mod';
    mod.textContent = `MOD ${formatMod(map[modKey])}`;

    const bonusWrap = document.createElement('label');
    bonusWrap.className = 'ability-bonus';
    bonusWrap.textContent = 'Item Bonus';
    const bonusInput = document.createElement('input');
    bonusInput.type = 'number';
    bonusInput.value = String(toNum(bonusRow?.value ?? 0));
    bonusInput.oninput = () => {
      setNumericVar(character, bonusKey, `${ab.label} Item Bonus`, bonusInput.value);
      renderSheet();
    };
    bonusWrap.appendChild(bonusInput);

    card.append(name, full, total, scoreWrap, mod, bonusWrap);
    wrap.appendChild(card);
  });
}

function getReferenceOptions(type, systemKey) {
  const all = state.referenceOptionsBySystem?.[systemKey] || {};
  const options = Array.isArray(all[type]) ? all[type] : [];
  if (options.length > 0) return options;
  const fallback = REFERENCE_FALLBACK[type] || [];
  return fallback.map((name) => ({ name, is_homebrew: false }));
}

function getEquipmentCatalog(systemKey) {
  const rows = state.equipmentCatalogBySystem?.[systemKey] || [];
  return Array.isArray(rows) ? rows : [];
}

function renderEquipmentCatalogSelect(systemKey) {
  const sel = $('equipmentCatalogSelect');
  if (!sel) return;

  const rows = getEquipmentCatalog(systemKey);
  sel.innerHTML = '';

  const fallback = document.createElement('option');
  fallback.value = '';
  fallback.textContent = rows.length ? 'Select equipment item' : 'No catalog items';
  sel.appendChild(fallback);

  rows.forEach((row) => {
    const o = document.createElement('option');
    o.value = String(row.id);
    o.textContent = row.is_homebrew ? `${row.name} (Homebrew)` : row.name;
    sel.appendChild(o);
  });
}

function renderReferenceSelect(selectId, type, currentValue, systemKey) {
  const select = $(selectId);
  if (!select) return;

  const options = getReferenceOptions(type, systemKey);
  select.innerHTML = '';

  const fallback = document.createElement('option');
  fallback.value = '';
  fallback.textContent = `Select ${type}`;
  select.appendChild(fallback);

  options.forEach((opt) => {
    const o = document.createElement('option');
    o.value = opt.name;
    o.textContent = opt.is_homebrew ? `${opt.name} (Homebrew)` : opt.name;
    select.appendChild(o);
  });

  select.value = currentValue || '';
  if (select.value === '' && currentValue) {
    const custom = document.createElement('option');
    custom.value = currentValue;
    custom.textContent = `${currentValue} (Custom)`;
    select.appendChild(custom);
    select.value = currentValue;
  }
}
function getClassEntries(character) {
  const raw = Array.isArray(character?.system_meta?.class_levels) ? character.system_meta.class_levels : [];
  const normalized = raw
    .map((r) => ({ class_name: String(r?.class_name || '').trim(), level: toNum(r?.level || 0) }))
    .filter((r) => r.class_name !== '' && r.level >= 0);

  if (normalized.length === 0) {
    return [{ class_name: 'Fighter', level: 1 }];
  }

  return normalized;
}

function setClassEntries(character, entries) {
  character.system_meta = character.system_meta || {};
  const clean = entries
    .map((e) => ({ class_name: String(e.class_name || '').trim(), level: Math.max(0, toNum(e.level)) }))
    .filter((e) => e.class_name !== '');

  character.system_meta.class_levels = clean.length > 0 ? clean : [{ class_name: 'Fighter', level: 1 }];
}

function syncClassLevelTotals(character) {
  const entries = getClassEntries(character);
  const total = entries.reduce((sum, e) => sum + Math.max(0, toNum(e.level)), 0);
  setNumericVar(character, 'total_level', 'Total Level', total);
  setNumericVar(character, 'level', 'Level', total);
}

function renderClassLevelEditor(character) {
  const wrap = $('classListWrap');
  if (!wrap) return;
  wrap.innerHTML = '';

  const entries = getClassEntries(character);
  setClassEntries(character, entries);

  entries.forEach((entry, index) => {
    const row = document.createElement('div');
    row.className = 'class-entry';

    const classSelect = document.createElement('select');
    CLASS_OPTIONS.forEach((name) => {
      const o = document.createElement('option');
      o.value = name;
      o.textContent = name;
      classSelect.appendChild(o);
    });

    if (CLASS_OPTIONS.includes(entry.class_name)) {
      classSelect.value = entry.class_name;
    }

    const levelSelect = document.createElement('select');
    for (let lvl = 1; lvl <= 20; lvl++) {
      const o = document.createElement('option');
      o.value = String(lvl);
      o.textContent = String(lvl);
      levelSelect.appendChild(o);
    }
    levelSelect.value = String(Math.min(20, Math.max(1, toNum(entry.level))));

    const removeBtnEl = document.createElement('button');
    removeBtnEl.type = 'button';
    removeBtnEl.textContent = 'X';
    removeBtnEl.disabled = entries.length <= 1;

    classSelect.onchange = () => {
      const next = getClassEntries(character);
      next[index].class_name = classSelect.value;
      setClassEntries(character, next);
      syncClassLevelTotals(character);
      renderSheet();
    };

    levelSelect.onchange = () => {
      const next = getClassEntries(character);
      next[index].level = toNum(levelSelect.value);
      setClassEntries(character, next);
      syncClassLevelTotals(character);
      renderSheet();
    };

    removeBtnEl.onclick = () => {
      const next = getClassEntries(character);
      next.splice(index, 1);
      setClassEntries(character, next);
      syncClassLevelTotals(character);
      renderSheet();
    };

    row.append(classSelect, levelSelect, removeBtnEl);
    wrap.appendChild(row);
  });
}

function bindHeaderFields(character) {
  const vars = character.sheet.variables;
  const systemKey = character.system_key || 'dnd5e2014';

  renderClassLevelEditor(character);
  renderReferenceSelect('race_select', 'race', String(getVar(vars, 'race')?.value || ''), systemKey);
  renderReferenceSelect('background_select', 'background', String(getVar(vars, 'background')?.value || ''), systemKey);

  const raceSelect = $('race_select');
  if (raceSelect) {
    raceSelect.onchange = () => {
      setTextVar(character, 'race', 'Race', raceSelect.value);
    };
  }

  const bgSelect = $('background_select');
  if (bgSelect) {
    bgSelect.onchange = () => {
      setTextVar(character, 'background', 'Background', bgSelect.value);
    };
  }
}
function bindNumericField(character, map, id, key, label, readOnly = false) {
  const input = $(id);
  if (!input) return;

  const row = getVar(character.sheet.variables, key);
  const usesFormula = !!(row && String(row.formula || '').trim());
  const value = usesFormula ? toNum(map[key]) : toNum(row?.value ?? 0);

  input.value = String(value);
  input.readOnly = readOnly || usesFormula;

  input.oninput = () => {
    if (input.readOnly) return;
    setNumericVar(character, key, label, input.value);
    renderSheet();
  };
}


function setDeathTrack(character, key, count) {
  setNumericVar(character, key, key === 'death_successes' ? 'Death Save Successes' : 'Death Save Failures', Math.max(0, Math.min(3, toNum(count))));
}

function bindArmorClassField(character, map) {
  const input = $('stat_ac');
  if (!input) return;

  const totalAc = toNum(map.ac);
  const equipBonus = toNum(getVar(character.sheet.variables, 'ac_equip_bonus')?.value || 0);
  input.value = String(totalAc);
  input.readOnly = false;

  input.oninput = () => {
    const nextTotal = toNum(input.value);
    setNumericVar(character, 'ac_base', 'Armor Class Base', nextTotal - equipBonus);
    renderSheet();
  };
}

function bindDeathSaves(character) {
  const success = toNum(getVar(character.sheet.variables, 'death_successes')?.value || 0);
  const fail = toNum(getVar(character.sheet.variables, 'death_failures')?.value || 0);

  const successIds = ['death_success_1', 'death_success_2', 'death_success_3'];
  const failIds = ['death_fail_1', 'death_fail_2', 'death_fail_3'];

  successIds.forEach((id, i) => {
    const box = $(id);
    if (!box) return;
    box.checked = i < success;
    box.onchange = () => {
      const count = successIds.reduce((n, sid) => n + ($(sid)?.checked ? 1 : 0), 0);
      setDeathTrack(character, 'death_successes', count);
      renderSheet();
    };
  });

  failIds.forEach((id, i) => {
    const box = $(id);
    if (!box) return;
    box.checked = i < fail;
    box.onchange = () => {
      const count = failIds.reduce((n, fid) => n + ($(fid)?.checked ? 1 : 0), 0);
      setDeathTrack(character, 'death_failures', count);
      renderSheet();
    };
  });
}

function bindHpAdjust(character) {
  const deltaInput = $('hp_delta');
  const healBtn = $('hp_heal_btn');
  const dmgBtn = $('hp_dmg_btn');
  if (!deltaInput || !healBtn || !dmgBtn) return;

  const applyDelta = (isHeal) => {
    const amt = Math.max(0, toNum(deltaInput.value));
    if (amt <= 0) return;

    const hpCurrentVar = getVar(character.sheet.variables, 'hp_current');
    const hpTempVar = getVar(character.sheet.variables, 'hp_temp');

    let hpCurrent = toNum(hpCurrentVar?.value || 0);
    let hpTemp = toNum(hpTempVar?.value || 0);

    if (isHeal) {
      hpCurrent += amt;
    } else {
      let remaining = amt;
      if (hpTemp > 0) {
        const consumed = Math.min(hpTemp, remaining);
        hpTemp -= consumed;
        remaining -= consumed;
      }
      hpCurrent -= remaining;
    }

    setNumericVar(character, 'hp_current', 'HP Current', hpCurrent);
    setNumericVar(character, 'hp_temp', 'Temp HP', hpTemp);
    renderSheet();
  };

  healBtn.onclick = () => applyDelta(true);
  dmgBtn.onclick = () => applyDelta(false);
}
function bindBlockField(character, id, blockId, title) {
  const input = $(id);
  if (!input) return;
  const block = ensureBlock(character, blockId, title);
  input.value = block.content || '';
  input.oninput = () => {
    block.content = input.value;
  };
}

function defaultEquipmentRow() {
  return {
    id: 0,
    name: '',
    category: 'gear',
    quantity: 1,
    equipped: true,
    ac_bonus: 0,
    str_bonus: 0,
    dex_bonus: 0,
    con_bonus: 0,
    int_bonus: 0,
    wis_bonus: 0,
    cha_bonus: 0,
    attack_ability: 'str',
    damage_dice: '',
    proficient: true,
    attack_text: '',
    notes: '',
    sort_order: 0,
  };
}

function equipmentRowFromCatalog(item) {
  return normalizeEquipmentRow({
    id: 0,
    name: String(item?.name || ''),
    category: String(item?.category || 'gear'),
    quantity: 1,
    equipped: true,
    ac_bonus: toNum(item?.ac_bonus || 0),
    str_bonus: toNum(item?.str_bonus || 0),
    dex_bonus: toNum(item?.dex_bonus || 0),
    con_bonus: toNum(item?.con_bonus || 0),
    int_bonus: toNum(item?.int_bonus || 0),
    wis_bonus: toNum(item?.wis_bonus || 0),
    cha_bonus: toNum(item?.cha_bonus || 0),
    attack_ability: String(item?.attack_ability || 'str'),
    damage_dice: String(item?.damage_dice || ''),
    proficient: !!item?.proficient,
    attack_text: String(item?.attack_text || ''),
    notes: String(item?.notes || ''),
    sort_order: 0,
  });
}

function normalizeEquipmentRow(row, index = 0) {
  const base = defaultEquipmentRow();
  const out = { ...base, ...(row || {}) };
  out.id = toNum(out.id);
  out.name = String(out.name || '').trim();
  out.category = EQUIPMENT_TYPES.includes(String(out.category || '').toLowerCase()) ? String(out.category || '').toLowerCase() : 'gear';
  out.quantity = Math.max(0, toNum(out.quantity || 1));
  out.equipped = !!out.equipped;
  out.ac_bonus = toNum(out.ac_bonus);
  out.str_bonus = toNum(out.str_bonus);
  out.dex_bonus = toNum(out.dex_bonus);
  out.con_bonus = toNum(out.con_bonus);
  out.int_bonus = toNum(out.int_bonus);
  out.wis_bonus = toNum(out.wis_bonus);
  out.cha_bonus = toNum(out.cha_bonus);
  out.attack_ability = ATTACK_ABILITIES.includes(String(out.attack_ability || '').toLowerCase()) ? String(out.attack_ability || '').toLowerCase() : 'str';
  out.damage_dice = String(out.damage_dice || '').trim();
  out.proficient = !!out.proficient;
  out.attack_text = String(out.attack_text || '').trim();
  out.notes = String(out.notes || '').trim();
  out.sort_order = toNum(out.sort_order || index);
  return out;
}

function getEquipmentEntries(character) {
  const rows = Array.isArray(character?.equipment) ? character.equipment : [];
  return rows.map((row, index) => normalizeEquipmentRow(row, index));
}

function setEquipmentEntries(character, rows) {
  character.equipment = (rows || []).map((row, index) => normalizeEquipmentRow(row, index));
}

function buildInventoryText(entries) {
  const lines = entries
    .filter((it) => it.name)
    .map((it) => {
      const tags = [];
      tags.push(it.category);
      if (it.equipped) tags.push('equipped');

      const mods = [];
      if (it.ac_bonus) mods.push(`AC ${formatMod(it.ac_bonus)}`);
      if (it.str_bonus) mods.push(`STR ${formatMod(it.str_bonus)}`);
      if (it.dex_bonus) mods.push(`DEX ${formatMod(it.dex_bonus)}`);
      if (it.con_bonus) mods.push(`CON ${formatMod(it.con_bonus)}`);
      if (it.int_bonus) mods.push(`INT ${formatMod(it.int_bonus)}`);
      if (it.wis_bonus) mods.push(`WIS ${formatMod(it.wis_bonus)}`);
      if (it.cha_bonus) mods.push(`CHA ${formatMod(it.cha_bonus)}`);
      if (it.damage_dice) mods.push(`DMG ${it.damage_dice} + ${it.attack_ability.toUpperCase()} mod${it.proficient ? ' + prof to hit' : ''}`);

      const qty = it.quantity > 1 ? `x${it.quantity} ` : '';
      const bonusPart = mods.length ? ` | ${mods.join(', ')}` : '';
      const notesPart = it.notes ? ` | ${it.notes}` : '';
      return `${qty}${it.name} [${tags.join(', ')}]${bonusPart}${notesPart}`;
    });
  return lines.join('\n');
}

function buildEquipmentAttackText(entries) {
  const lines = entries
    .filter((it) => it.name && it.attack_text)
    .map((it) => `${it.name}: ${it.attack_text}`);
  return lines.join('\n');
}

function getEquipmentDamageExpr(item) {
  const direct = String(item?.damage_dice || '').trim();
  if (direct) return direct;

  const fromAttackText = String(item?.attack_text || '');
  const m = fromAttackText.match(/(\d+d\d+(?:\s*[+-]\s*\d+)?)/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

function applyEquipmentEffects(character) {
  const entries = getEquipmentEntries(character);
  setEquipmentEntries(character, entries);

  let acBonus = 0;
  const totals = { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 };
  entries.forEach((it) => {
    if (!it.equipped) return;
    acBonus += toNum(it.ac_bonus);
    totals.str += toNum(it.str_bonus);
    totals.dex += toNum(it.dex_bonus);
    totals.con += toNum(it.con_bonus);
    totals.int += toNum(it.int_bonus);
    totals.wis += toNum(it.wis_bonus);
    totals.cha += toNum(it.cha_bonus);
  });

  setNumericVar(character, 'ac_equip_bonus', 'Armor Class Equipment Bonus', acBonus);
  ABILITIES.forEach((ab) => {
    setNumericVar(character, `${ab.key}_equip_bonus`, `${ab.label} Equipment Bonus`, totals[ab.key]);
  });

  const inventoryBlock = ensureBlock(character, 'inventory', 'Inventory / Equipment');
  inventoryBlock.content = buildInventoryText(entries);
}

function renderEquipmentAttackPreview(character) {
  const el = $('equipmentAttackList');
  if (!el) return;
  const map = evaluateSheet(character.sheet);
  const entries = getEquipmentEntries(character);
  const lines = entries
    .filter((it) => it.name && getEquipmentDamageExpr(it))
    .map((it) => {
      const abilityKey = it.attack_ability || 'str';
      const statMod = toNum(map[`${abilityKey}_mod`]);
      const profBonus = it.proficient ? toNum(map.prof_bonus) : 0;
      const toHit = formatMod(statMod + profBonus);
      const baseDmg = getEquipmentDamageExpr(it);
      const dmg = `${baseDmg} ${statMod >= 0 ? '+' : '-'} ${Math.abs(statMod)}`;
      const profText = it.proficient ? 'prof' : 'no-prof';
      const equippedText = it.equipped ? '' : ' [not equipped]';
      return `${it.name}${equippedText}: to hit ${toHit} (${abilityKey.toUpperCase()}, ${profText}) | dmg ${dmg}`;
    });
  const fallback = buildEquipmentAttackText(entries);
  el.textContent = lines.length ? lines.join('\n') : (fallback || 'No equipment attacks configured.');
}

function renderEquipmentAttackSelect(character) {
  const sel = $('equipmentAttackSelect');
  if (!sel) return;

  const rows = getEquipmentEntries(character);
  const prev = sel.value;
  sel.innerHTML = '';

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Select equipment attack';
  sel.appendChild(placeholder);

  rows.forEach((it, index) => {
    const dmgExpr = getEquipmentDamageExpr(it);
    if (!it.name || !dmgExpr) return;
    const o = document.createElement('option');
    o.value = String(index);
    o.textContent = `${it.name}${it.equipped ? '' : ' [not equipped]'} (${it.attack_ability.toUpperCase()} ${dmgExpr}${it.proficient ? ', prof' : ''})`;
    sel.appendChild(o);
  });

  if ([...sel.options].some((o) => o.value === prev)) {
    sel.value = prev;
  }
}

function rollSelectedEquipmentAttack() {
  const c = state.current;
  if (!c) return setStatus('Load a character first');

  const sel = $('equipmentAttackSelect');
  const idx = toNum(sel?.value || -1);
  if (idx < 0) return setStatus('Select an equipment attack');

  const rows = getEquipmentEntries(c);
  const it = rows[idx];
  const baseDmg = getEquipmentDamageExpr(it);
  if (!it || !it.name || !baseDmg) return setStatus('Invalid equipment attack');

  const map = evaluateSheet(c.sheet);
  const abilityKey = ATTACK_ABILITIES.includes(it.attack_ability) ? it.attack_ability : 'str';
  const statMod = toNum(map[`${abilityKey}_mod`]);
  const profBonus = it.proficient ? toNum(map.prof_bonus) : 0;

  const d20 = 1 + Math.floor(Math.random() * 20);
  const toHitTotal = d20 + statMod + profBonus;

  const dmgExpr = `${baseDmg} ${statMod >= 0 ? '+' : '-'} ${Math.abs(statMod)}`;
  const dmg = parseRoll(dmgExpr, {});

  $('rollOut').textContent =
    `Attack: ${it.name}\n` +
    `To Hit: 1d20(${d20}) + ${abilityKey}_mod(${formatMod(statMod)})` +
    `${it.proficient ? ` + prof_bonus(${formatMod(profBonus)})` : ''} = ${toHitTotal}\n` +
    `Damage: ${dmgExpr} = ${dmg.total}`;
}

function renderEquipmentEditor(character) {
  const table = $('equipmentTable');
  const tbody = table?.querySelector('tbody');
  if (!tbody) return;

  const rows = getEquipmentEntries(character);
  tbody.innerHTML = '';

  const makeNumberInput = (value) => {
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '1';
    input.value = String(toNum(value));
    return input;
  };

  rows.forEach((item, index) => {
    const tr = document.createElement('tr');

    const tdEq = document.createElement('td');
    const equipped = document.createElement('input');
    equipped.type = 'checkbox';
    equipped.className = 'equip-col';
    equipped.checked = !!item.equipped;
    equipped.onchange = () => {
      const next = getEquipmentEntries(character);
      next[index].equipped = equipped.checked;
      setEquipmentEntries(character, next);
      renderSheet();
    };
    tdEq.appendChild(equipped);

    const tdName = document.createElement('td');
    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'name-col';
    name.value = item.name;
    name.oninput = () => {
      const next = getEquipmentEntries(character);
      next[index].name = name.value;
      setEquipmentEntries(character, next);
      applyEquipmentEffects(character);
      renderEquipmentAttackPreview(character);
      renderEquipmentAttackSelect(character);
    };
    tdName.appendChild(name);

    const tdType = document.createElement('td');
    const type = document.createElement('select');
    EQUIPMENT_TYPES.forEach((t) => {
      const o = document.createElement('option');
      o.value = t;
      o.textContent = t;
      type.appendChild(o);
    });
    type.value = item.category;
    type.onchange = () => {
      const next = getEquipmentEntries(character);
      next[index].category = type.value;
      setEquipmentEntries(character, next);
      applyEquipmentEffects(character);
      renderEquipmentAttackPreview(character);
    };
    tdType.appendChild(type);

    const tdQty = document.createElement('td');
    const qty = makeNumberInput(item.quantity);
    qty.onchange = () => {
      const next = getEquipmentEntries(character);
      next[index].quantity = Math.max(0, toNum(qty.value));
      setEquipmentEntries(character, next);
      applyEquipmentEffects(character);
      renderEquipmentAttackPreview(character);
    };
    tdQty.appendChild(qty);

    const bonusKeys = ['ac_bonus', 'str_bonus', 'dex_bonus', 'con_bonus', 'int_bonus', 'wis_bonus', 'cha_bonus'];
    const bonusTds = bonusKeys.map((key) => {
      const td = document.createElement('td');
      const inp = makeNumberInput(item[key]);
      inp.onchange = () => {
        const next = getEquipmentEntries(character);
        next[index][key] = toNum(inp.value);
        setEquipmentEntries(character, next);
        renderSheet();
      };
      td.appendChild(inp);
      return td;
    });

    const tdAtkAbility = document.createElement('td');
    const atkAbility = document.createElement('select');
    atkAbility.className = 'attack-ability-col';
    ATTACK_ABILITIES.forEach((key) => {
      const o = document.createElement('option');
      o.value = key;
      o.textContent = key.toUpperCase();
      atkAbility.appendChild(o);
    });
    atkAbility.value = item.attack_ability;
    atkAbility.onchange = () => {
      const next = getEquipmentEntries(character);
      next[index].attack_ability = atkAbility.value;
      setEquipmentEntries(character, next);
      renderEquipmentAttackPreview(character);
      renderEquipmentAttackSelect(character);
    };
    tdAtkAbility.appendChild(atkAbility);

    const tdProf = document.createElement('td');
    const prof = document.createElement('input');
    prof.type = 'checkbox';
    prof.className = 'equip-col';
    prof.checked = !!item.proficient;
    prof.onchange = () => {
      const next = getEquipmentEntries(character);
      next[index].proficient = prof.checked;
      setEquipmentEntries(character, next);
      renderEquipmentAttackPreview(character);
      renderEquipmentAttackSelect(character);
    };
    tdProf.appendChild(prof);

    const tdDmgDice = document.createElement('td');
    const dmgDice = document.createElement('input');
    dmgDice.type = 'text';
    dmgDice.className = 'damage-dice-col';
    dmgDice.value = item.damage_dice;
    dmgDice.oninput = () => {
      const next = getEquipmentEntries(character);
      next[index].damage_dice = dmgDice.value;
      setEquipmentEntries(character, next);
      renderEquipmentAttackPreview(character);
      renderEquipmentAttackSelect(character);
    };
    tdDmgDice.appendChild(dmgDice);

    const tdAttack = document.createElement('td');
    const attack = document.createElement('input');
    attack.type = 'text';
    attack.className = 'attack-col';
    attack.value = item.attack_text;
    attack.oninput = () => {
      const next = getEquipmentEntries(character);
      next[index].attack_text = attack.value;
      setEquipmentEntries(character, next);
      renderEquipmentAttackPreview(character);
    };
    tdAttack.appendChild(attack);

    const tdNotes = document.createElement('td');
    const notes = document.createElement('input');
    notes.type = 'text';
    notes.className = 'notes-col';
    notes.value = item.notes;
    notes.oninput = () => {
      const next = getEquipmentEntries(character);
      next[index].notes = notes.value;
      setEquipmentEntries(character, next);
      applyEquipmentEffects(character);
    };
    tdNotes.appendChild(notes);

    const tdDel = document.createElement('td');
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = 'X';
    del.onclick = () => {
      const next = getEquipmentEntries(character);
      next.splice(index, 1);
      setEquipmentEntries(character, next);
      renderSheet();
    };
    tdDel.appendChild(del);

    tr.append(tdEq, tdName, tdType, tdQty, ...bonusTds, tdAtkAbility, tdProf, tdDmgDice, tdAttack, tdNotes, tdDel);
    tbody.appendChild(tr);
  });
}

function renderSystems() {
  const sel = $('newSystem');
  sel.innerHTML = '';
  state.systems.forEach((s) => {
    const o = document.createElement('option');
    o.value = s.system_key;
    o.textContent = `${s.name} (${s.version_label || ''})`;
    sel.appendChild(o);
  });
  sel.onchange = renderTemplates;
  renderTemplates();
}

function renderTemplates() {
  const systemKey = $('newSystem').value;
  const templates = state.templatesBySystem[systemKey] || [];
  const sel = $('newTemplate');
  sel.innerHTML = '';
  templates.forEach((t) => {
    const o = document.createElement('option');
    o.value = t.id;
    o.textContent = t.name;
    sel.appendChild(o);
  });
}

function renderCharactersList() {
  const list = $('characterList');
  if (!list) return;
  list.innerHTML = '';
  state.characters.forEach((c) => {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = `${c.name} [${c.system_key}]`;
    list.appendChild(o);
  });
}

function rowInput(value) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value ?? '';
  return input;
}

function removeBtn(onClick) {
  const b = document.createElement('button');
  b.textContent = 'X';
  b.onclick = onClick;
  return b;
}

function ensure5eHelperStructure(character) {
  if (!character?.system_meta?.use_5e_helpers) return;
  const vars = character.sheet.variables || [];

  ABILITIES.forEach((ab) => {
    upsertVar(vars, ab.key, ab.label, 10, '');
    upsertVar(vars, `${ab.key}_item_bonus`, `${ab.label} Item Bonus`, 0, '');
    upsertVar(vars, `${ab.key}_equip_bonus`, `${ab.label} Equipment Bonus`, 0, '');
    const modVar = upsertVar(vars, `${ab.key}_mod`, `${ab.label} Mod`, 0, '');
    if (!String(modVar.formula || '').trim()) {
      modVar.formula = `floor(((${ab.key} + ${ab.key}_item_bonus + ${ab.key}_equip_bonus) - 10) / 2)`;
    }
  });
  const totalLevel = upsertVar(vars, 'total_level', 'Total Level', 1, '');
  totalLevel.formula = '';

  upsertVar(vars, 'race', 'Race', '', '');
  upsertVar(vars, 'background', 'Background', '', '');

  const prof = upsertVar(vars, 'prof_bonus', 'Proficiency Bonus', 2, '');
  prof.formula = '2 + floor((total_level - 1) / 4)';

  const acExisting = getVar(vars, 'ac');
  const acBase = upsertVar(vars, 'ac_base', 'Armor Class Base', toNum(acExisting?.value ?? 10), '');
  acBase.formula = '';
  const acEquip = upsertVar(vars, 'ac_equip_bonus', 'Armor Class Equipment Bonus', 0, '');
  acEquip.formula = '';
  const ac = upsertVar(vars, 'ac', 'Armor Class', 10, '');
  if (!String(ac.formula || '').trim()) {
    ac.formula = 'ac_base + ac_equip_bonus';
  }
  upsertVar(vars, 'initiative', 'Initiative', 0, 'dex_mod');
  upsertVar(vars, 'speed', 'Speed', 30, '');
  upsertVar(vars, 'hp_max', 'HP Max', 10, '');
  upsertVar(vars, 'hp_current', 'HP Current', 10, '');
  upsertVar(vars, 'hp_temp', 'Temp HP', 0, '');
  upsertVar(vars, 'death_successes', 'Death Save Successes', 0, '');
  upsertVar(vars, 'death_failures', 'Death Save Failures', 0, '');

  BLOCK_FIELDS.forEach((b) => ensureBlock(character, b.id, b.title));
}

function renderAdvancedEditor(character) {
  const varsBody = $('varsTable').querySelector('tbody');
  varsBody.innerHTML = '';
  const showAdvanced = !!$('showAdvancedVars').checked;

  (character.sheet.variables || []).forEach((v, i) => {
    if (!showAdvanced && isAdvancedVarKey(v.key)) return;

    const tr = document.createElement('tr');
    const key = rowInput(v.key || '');
    const label = rowInput(v.label || '');
    const val = rowInput(v.value ?? '');
    const formula = rowInput(v.formula || '');
    const comp = document.createElement('td');
    comp.textContent = String(v.computed ?? v.value ?? '');

    key.oninput = () => { v.key = key.value.trim(); renderSheet(); };
    label.oninput = () => { v.label = label.value; };
    val.oninput = () => { v.value = val.value; renderSheet(); };
    formula.oninput = () => { v.formula = formula.value; renderSheet(); };

    [key, label, val, formula].forEach((el) => {
      const td = document.createElement('td');
      td.appendChild(el);
      tr.appendChild(td);
    });

    tr.appendChild(comp);
    const tdDel = document.createElement('td');
    tdDel.appendChild(removeBtn(() => {
      character.sheet.variables.splice(i, 1);
      renderSheet();
    }));
    tr.appendChild(tdDel);
    varsBody.appendChild(tr);
  });

  const macrosBody = $('macrosTable').querySelector('tbody');
  macrosBody.innerHTML = '';
  (character.sheet.macros || []).forEach((m, i) => {
    const tr = document.createElement('tr');
    const name = rowInput(m.name || '');
    const expr = rowInput(m.expr || '');
    name.oninput = () => { m.name = name.value; };
    expr.oninput = () => { m.expr = expr.value; };

    const td1 = document.createElement('td');
    td1.appendChild(name);
    const td2 = document.createElement('td');
    td2.appendChild(expr);
    const td3 = document.createElement('td');
    td3.appendChild(removeBtn(() => {
      character.sheet.macros.splice(i, 1);
      renderSheet();
    }));

    tr.append(td1, td2, td3);
    macrosBody.appendChild(tr);
  });

  const wrap = $('blocksWrap');
  wrap.innerHTML = '';
  (character.sheet.blocks || []).forEach((b, i) => {
    const card = document.createElement('div');
    card.className = 'block';

    const title = rowInput(b.title || '');
    const text = document.createElement('textarea');
    text.value = b.content || '';
    text.rows = 4;
    title.oninput = () => { b.title = title.value; };
    text.oninput = () => { b.content = text.value; };

    const del = removeBtn(() => {
      character.sheet.blocks.splice(i, 1);
      renderSheet();
    });

    card.append(title, text, del);
    wrap.appendChild(card);
  });
}

function renderSheet() {
  const ch = state.current;
  if (!ch) return;

  state.isRendering = true;
  ensure5eHelperStructure(ch);
  syncClassLevelTotals(ch);
  applyEquipmentEffects(ch);
  const map = evaluateSheet(ch.sheet);

  if ($('charName')) $('charName').value = ch.name;
  if ($('charHelpers')) $('charHelpers').checked = !!(ch.system_meta && ch.system_meta.use_5e_helpers);
  setAppTitle(ch.name);

  bindHeaderFields(ch);
  renderEquipmentCatalogSelect(ch.system_key || 'dnd5e2014');
  renderAbilities(ch, map);

  bindNumericField(ch, map, 'stat_prof_bonus', 'prof_bonus', 'Proficiency Bonus', true);
  bindArmorClassField(ch, map);
  bindNumericField(ch, map, 'stat_initiative', 'initiative', 'Initiative', false);
  bindNumericField(ch, map, 'stat_speed', 'speed', 'Speed', false);
  bindNumericField(ch, map, 'hp_max', 'hp_max', 'HP Max', false);
  bindNumericField(ch, map, 'hp_current', 'hp_current', 'HP Current', false);
  bindNumericField(ch, map, 'hp_temp', 'hp_temp', 'Temp HP', false);
  bindHpAdjust(ch);
  bindDeathSaves(ch);
  renderEquipmentEditor(ch);
  renderEquipmentAttackPreview(ch);
  renderEquipmentAttackSelect(ch);

  BLOCK_FIELDS.forEach((b) => bindBlockField(ch, b.inputId, b.id, b.title));

  renderAdvancedEditor(ch);
  renderInventorySummary(ch);
  const avatar = $('avatarToken');
  if (avatar) avatar.textContent = String(ch.name || 'TS').slice(0, 2).toUpperCase();
  state.isRendering = false;
}

async function loadCharacter(id) {
  const res = await apiGet('character', { id });
  if (!res.ok) return setStatus(res.error || 'Load failed');

  const c = res.character;
  c.system_meta = JSON.parse(c.system_meta_json || '{}');
  c.sheet = c.sheet || { variables: [], blocks: [], macros: [] };
  c.equipment = Array.isArray(c.equipment) ? c.equipment : [];

  state.current = c;
  renderSheet();
  state.lastSavedHash = characterHash(c);
  state.dirty = false;
  await refreshVersions();
  showView('sheet');
  setStatus(`Loaded #${id}`);
  setAutosaveState('Autosaved', 'saved');
}

async function bootstrap() {
  const res = await apiGet('bootstrap');
  if (!res.ok) return setStatus('Bootstrap failed');

  state.systems = res.systems || [];
  state.templatesBySystem = res.templates || {};
  state.referenceOptionsBySystem = res.reference_options || {};
  state.equipmentCatalogBySystem = res.equipment_catalog || {};
  state.characters = res.characters || [];

  renderSystems();
  renderCharactersList();
  renderRoster();
  if (!state.current) setAppTitle('');
}

async function addHomebrewOption(type) {
  const c = state.current;
  const systemKey = c?.system_key || $('newSystem').value || 'dnd5e2014';
  const label = type === 'race' ? 'race' : 'background';
  const name = window.prompt(`Enter new ${label} name:`)?.trim();
  if (!name) return;

  const res = await apiPost('add_reference_option', {
    system_key: systemKey,
    option_type: type,
    name,
  });

  if (!res.ok) return setStatus(res.error || 'Failed to add option');
  await bootstrap();
  if (state.current) {
    setTextVar(state.current, type, type[0].toUpperCase() + type.slice(1), name);
    renderSheet();
  }
}

function addSelectedCatalogEquipmentToCharacter() {
  const c = state.current;
  if (!c) return setStatus('Load a character first');

  const sel = $('equipmentCatalogSelect');
  const catalogId = toNum(sel?.value || 0);
  if (!catalogId) return setStatus('Select an equipment item first');

  const rows = getEquipmentCatalog(c.system_key || 'dnd5e2014');
  const item = rows.find((it) => toNum(it.id) === catalogId);
  if (!item) return setStatus('Catalog item not found');

  const next = getEquipmentEntries(c);
  next.push(equipmentRowFromCatalog(item));
  setEquipmentEntries(c, next);
  renderSheet();
}

async function addEquipmentCatalogItem() {
  const c = state.current;
  const systemKey = c?.system_key || $('newSystem').value || 'dnd5e2014';

  const name = window.prompt('Equipment name:')?.trim();
  if (!name) return;

  const category = (window.prompt(`Category (${EQUIPMENT_TYPES.join(', ')}):`, 'gear') || 'gear').trim().toLowerCase();
  const safeCategory = EQUIPMENT_TYPES.includes(category) ? category : 'gear';

  const item = {
    name,
    category: safeCategory,
    ac_bonus: toNum(window.prompt('AC bonus (number):', '0') || 0),
    str_bonus: toNum(window.prompt('STR bonus (number):', '0') || 0),
    dex_bonus: toNum(window.prompt('DEX bonus (number):', '0') || 0),
    con_bonus: toNum(window.prompt('CON bonus (number):', '0') || 0),
    int_bonus: toNum(window.prompt('INT bonus (number):', '0') || 0),
    wis_bonus: toNum(window.prompt('WIS bonus (number):', '0') || 0),
    cha_bonus: toNum(window.prompt('CHA bonus (number):', '0') || 0),
    attack_ability: (window.prompt(`Attack ability (${ATTACK_ABILITIES.join(', ')}):`, 'str') || 'str').trim().toLowerCase(),
    damage_dice: String(window.prompt('Damage dice (e.g. 1d8):', '') || ''),
    proficient: (window.prompt('Proficient by default? (y/n):', 'y') || 'y').trim().toLowerCase().startsWith('y'),
    attack_text: String(window.prompt('Attack text (optional):', '') || ''),
    notes: String(window.prompt('Notes (optional):', '') || ''),
  };

  if (!ATTACK_ABILITIES.includes(item.attack_ability)) {
    item.attack_ability = 'str';
  }

  const res = await apiPost('add_equipment_catalog_item', { system_key: systemKey, item });
  if (!res.ok) return setStatus(res.error || 'Failed to add catalog item');

  await bootstrap();
  if (state.current) {
    renderSheet();
  }
  setStatus('Equipment item added to DB catalog');
}

async function createNamedSnapshot(source, fallbackLabel) {
  const c = state.current;
  if (!c) return setStatus('Load a character first');
  const label = window.prompt('Snapshot label:', fallbackLabel)?.trim() || fallbackLabel;
  await saveCurrentCharacter(source, label, { create_version: true });
}

async function restoreVersion(versionId) {
  if (!window.confirm('Restore this version over the current character?')) return;
  const res = await apiPost('restore_character_version', { version_id: versionId });
  if (!res.ok) return setStatus(res.error || 'Restore failed');
  await bootstrap();
  await loadCharacter(res.character_id);
  setStatus('Version restored');
}

async function duplicateVersion(versionId) {
  const res = await apiPost('duplicate_character_version', { version_id: versionId });
  if (!res.ok) return setStatus(res.error || 'Duplicate failed');
  await bootstrap();
  await loadCharacter(res.character_id);
  setStatus('Version duplicated');
}

$('createBtn').onclick = async () => {
  const name = $('newName').value.trim();
  if (!name) return setStatus('Character name required');

  const payload = {
    name,
    system_key: $('newSystem').value,
    template_id: Number($('newTemplate').value || 0),
    use_5e_helpers: $('newHelpers').checked,
  };

  const res = await apiPost('create_character', payload);
  if (!res.ok) return setStatus(res.error || 'Create failed');

  await bootstrap();
  await loadCharacter(res.id);
  setStatus(`Created #${res.id}`);
};

$('loadBtn').onclick = async () => {
  const id = Number($('characterList').value || 0);
  if (!id) return setStatus('Select a character first');
  await loadCharacter(id);
};

$('saveBtn').onclick = async () => {
  await saveCurrentCharacter('manual', 'Manual Save');
};

$('addRaceBtn').onclick = async () => addHomebrewOption('race');
$('addBackgroundBtn').onclick = async () => addHomebrewOption('background');
$('addCatalogEquipmentBtn').onclick = () => addSelectedCatalogEquipmentToCharacter();
$('addEquipmentCatalogBtn').onclick = async () => addEquipmentCatalogItem();

$('addClassBtn').onclick = () => {
  if (!state.current) return;
  const entries = getClassEntries(state.current);
  entries.push({ class_name: 'Wizard', level: 1 });
  setClassEntries(state.current, entries);
  syncClassLevelTotals(state.current);
  renderSheet();
};

$('addEquipmentBtn').onclick = () => {
  if (!state.current) return;
  const rows = getEquipmentEntries(state.current);
  rows.push(defaultEquipmentRow());
  setEquipmentEntries(state.current, rows);
  renderSheet();
};

$('addVarBtn').onclick = () => {
  if (!state.current) return;
  state.current.sheet.variables.push({ key: 'new_key', label: 'New Var', value: '', formula: '' });
  renderSheet();
};

$('addMacroBtn').onclick = () => {
  if (!state.current) return;
  state.current.sheet.macros.push({ name: 'New Macro', expr: '1d20' });
  renderSheet();
};

$('addBlockBtn').onclick = () => {
  if (!state.current) return;
  state.current.sheet.blocks.push({ id: `block_${Date.now()}`, title: 'New Block', content: '' });
  renderSheet();
};

$('charName').oninput = () => {
  if (!state.current) return;
  setAppTitle($('charName').value);
};

$('showAdvancedVars').onchange = () => {
  if (state.current) renderSheet();
};

$('rollBtn').onclick = () => {
  const c = state.current;
  const map = c ? evaluateSheet(c.sheet) : {};
  const expr = $('rollExpr').value;
  const result = parseRoll(expr, map);
  $('rollOut').textContent = `${result.detail}\nTotal: ${result.total}`;
};

$('rollEquipmentAttackBtn').onclick = () => {
  rollSelectedEquipmentAttack();
};

if ($('brandBtn')) $('brandBtn').onclick = () => showView('roster');
if ($('navRosterBtn')) $('navRosterBtn').onclick = () => showView('roster');
if ($('backToRosterBtn')) $('backToRosterBtn').onclick = () => showView('roster');
if ($('openHistoryBtn')) $('openHistoryBtn').onclick = async () => {
  await refreshVersions();
  showView('history');
};
if ($('closeHistoryBtn')) $('closeHistoryBtn').onclick = () => showView('sheet');
if ($('sessionSnapshotBtn')) $('sessionSnapshotBtn').onclick = () => createNamedSnapshot('session', 'Session Snapshot');
if ($('levelSnapshotBtn')) $('levelSnapshotBtn').onclick = () => createNamedSnapshot('level_up', 'Level-Up Snapshot');
if ($('globalSearch')) $('globalSearch').oninput = renderRoster;
if ($('rosterSort')) $('rosterSort').onchange = renderRoster;

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.onclick = () => setActiveTab(btn.dataset.tab || 'features');
});

const sheetView = $('sheetView');
if (sheetView) {
  sheetView.addEventListener('input', (ev) => {
    const el = ev.target;
    if (!el || el.id === 'rollExpr' || el.id === 'hp_delta') return;
    scheduleAutosave();
  }, true);
  sheetView.addEventListener('change', (ev) => {
    const el = ev.target;
    if (!el || el.id === 'equipmentAttackSelect' || el.id === 'showAdvancedVars') return;
    scheduleAutosave();
  }, true);
  sheetView.addEventListener('click', (ev) => {
    const el = ev.target;
    if (!(el instanceof HTMLButtonElement)) return;
    if ([
      'saveBtn', 'backToRosterBtn', 'openHistoryBtn', 'sessionSnapshotBtn',
      'levelSnapshotBtn', 'rollBtn', 'rollEquipmentAttackBtn',
    ].includes(el.id)) return;
    if (el.classList.contains('tab-btn')) return;
    setTimeout(scheduleAutosave, 0);
  }, true);
}

setActiveTab('features');
showView('roster');
bootstrap();



























