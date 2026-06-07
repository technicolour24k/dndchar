<?php declare(strict_types=1); ?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TavernSheet</title>
  <link rel="stylesheet" href="assets/style.css">
</head>
<body>
  <header class="topbar">
    <button id="brandBtn" class="brand" type="button" title="Character roster">
      <span class="brand-mark">TS</span>
      <span id="appTitle">TavernSheet</span>
    </button>
    <nav class="topnav" aria-label="Primary">
      <button id="navRosterBtn" class="nav-pill active" type="button">Roster</button>
      <button class="nav-pill muted" type="button">Campaigns</button>
      <button class="nav-pill muted" type="button">Session</button>
      <button class="nav-pill muted" type="button">Library</button>
    </nav>
    <label class="global-search">
      <span>Search</span>
      <input id="globalSearch" type="search" placeholder="Search characters">
    </label>
    <div id="status" class="status">Ready</div>
  </header>

  <main class="app-shell">
    <section id="rosterView" class="view roster-view">
      <aside class="panel roster-tools">
        <div class="panel-head">
          <h2>Create Character</h2>
        </div>
        <label>Name <input id="newName" type="text" placeholder="Aria the Brave"></label>
        <label>System <select id="newSystem"></select></label>
        <label>Template <select id="newTemplate"></select></label>
        <label class="inline"><input id="newHelpers" type="checkbox" checked> Use 5e helpers</label>
        <button id="createBtn" class="primary-action" type="button">Add Character</button>

        <div class="divider"></div>
        <label>Sort
          <select id="rosterSort">
            <option value="updated">Recently updated</option>
            <option value="name">Name A-Z</option>
            <option value="level">Level high-low</option>
          </select>
        </label>
        <label>Legacy selector <select id="characterList" size="7"></select></label>
        <button id="loadBtn" type="button">Load Selected</button>
      </aside>

      <section class="panel roster-main">
        <div class="panel-head roster-heading">
          <div>
            <h2>Character Roster</h2>
            <p>Manage D&D 5E 2014 characters, quick stats, and recent saves.</p>
          </div>
          <div class="roster-count" id="rosterCount">0 characters</div>
        </div>
        <div id="characterRoster" class="character-roster"></div>
      </section>
    </section>

    <section id="sheetView" class="view sheet-view is-hidden">
      <section class="sheet-toolbar panel">
        <button id="backToRosterBtn" type="button">Roster</button>
        <label class="character-name-field">Character Name <input id="charName" type="text"></label>
        <label class="inline"><input id="charHelpers" type="checkbox"> 5e helpers</label>
        <button id="saveBtn" class="primary-action" type="button">Save</button>
        <button id="sessionSnapshotBtn" type="button">Session Snapshot</button>
        <button id="levelSnapshotBtn" type="button">Level-Up Snapshot</button>
        <button id="openHistoryBtn" type="button">Versions</button>
        <span id="autosaveState" class="autosave-state">Autosave: idle</span>
      </section>

      <div class="sheet-layout">
        <aside class="sheet-left">
          <section class="panel identity-panel">
            <div class="avatar-token" id="avatarToken">TS</div>
            <div class="identity-grid slim">
              <section class="identity-card">
                <h3>Class & Level</h3>
                <div id="classListWrap" class="class-list"></div>
                <button id="addClassBtn" type="button">Add Class</button>
              </section>
              <section class="identity-card">
                <h3>Race</h3>
                <div class="picker-row">
                  <select id="race_select"></select>
                  <button id="addRaceBtn" type="button">Homebrew</button>
                </div>
              </section>
              <section class="identity-card">
                <h3>Background</h3>
                <div class="picker-row">
                  <select id="background_select"></select>
                  <button id="addBackgroundBtn" type="button">Homebrew</button>
                </div>
              </section>
            </div>
          </section>

          <section class="panel primary-stats">
            <div class="panel-head">
              <h3>Core Stats</h3>
              <span>Inline edits enabled</span>
            </div>
            <div id="abilityColumn" class="ability-column"></div>
            <div class="primary-core-row">
              <label class="stat-card compact">Prof <input id="stat_prof_bonus" type="number"></label>
              <label class="stat-card compact">AC <input id="stat_ac" type="number"></label>
              <label class="stat-card compact">Init <input id="stat_initiative" type="number"></label>
              <label class="stat-card compact">Speed <input id="stat_speed" type="number"></label>
            </div>
          </section>

          <section class="panel version-preview">
            <div class="panel-head">
              <h3>Version History</h3>
              <span id="versionPreviewCount">0 entries</span>
            </div>
            <div id="latestVersions" class="version-list"></div>
          </section>
        </aside>

        <section class="sheet-center">
          <div class="tabbar panel">
            <button class="tab-btn active" type="button" data-tab="features">Features</button>
            <button class="tab-btn" type="button" data-tab="spells">Spells</button>
            <button class="tab-btn" type="button" data-tab="equipment">Equipment</button>
            <button class="tab-btn" type="button" data-tab="backstory">Backstory</button>
            <button class="tab-btn" type="button" data-tab="advanced">Advanced</button>
          </div>

          <section class="tab-panel active" data-panel="features">
            <div class="feature-grid">
              <label class="panel panel-block tall">
                Attacks & Spellcasting
                <textarea id="block_attacks" rows="7"></textarea>
                <span class="equipment-attack-title">Equipment Attacks</span>
                <pre id="equipmentAttackList"></pre>
              </label>
              <section class="panel roll-panel">
                <h3>Dice Roller</h3>
                <label>Expression <input id="rollExpr" type="text" value="1d20 + dex_mod"></label>
                <button id="rollBtn" type="button">Roll</button>
                <label>Equipment Attack <select id="equipmentAttackSelect"></select></label>
                <button id="rollEquipmentAttackBtn" type="button">Roll Equipment Attack</button>
                <pre id="rollOut"></pre>
              </section>
            </div>
          </section>

          <section class="tab-panel" data-panel="spells">
            <label class="panel panel-block tall">Spellcasting Notes <textarea id="block_spellcasting" rows="12"></textarea></label>
          </section>

          <section class="tab-panel" data-panel="equipment">
            <section class="panel panel-block tall equipment-panel">
              <div class="equipment-head">
                <span>Inventory / Equipment</span>
                <div class="equipment-actions">
                  <select id="equipmentCatalogSelect"></select>
                  <button id="addCatalogEquipmentBtn" type="button">Add From DB</button>
                  <button id="addEquipmentCatalogBtn" type="button">New DB Item</button>
                  <button id="addEquipmentBtn" type="button">Blank</button>
                </div>
              </div>
              <div class="equipment-table-wrap">
                <table id="equipmentTable" class="equipment-table">
                  <thead>
                    <tr>
                      <th>Eq</th><th>Name</th><th>Type</th><th>Qty</th><th>AC</th><th>STR</th><th>DEX</th><th>CON</th><th>INT</th><th>WIS</th><th>CHA</th><th>Atk Stat</th><th>Prof</th><th>Dmg Dice</th><th>Attack</th><th>Notes</th><th></th>
                    </tr>
                  </thead>
                  <tbody></tbody>
                </table>
              </div>
            </section>
          </section>

          <section class="tab-panel" data-panel="backstory">
            <div class="roleplay-grid">
              <label class="panel panel-block">Personality Traits <textarea id="block_personality_traits" rows="5"></textarea></label>
              <label class="panel panel-block">Ideals <textarea id="block_ideals" rows="5"></textarea></label>
              <label class="panel panel-block">Bonds <textarea id="block_bonds" rows="5"></textarea></label>
              <label class="panel panel-block">Flaws <textarea id="block_flaws" rows="5"></textarea></label>
            </div>
          </section>

          <section class="tab-panel" data-panel="advanced">
            <section class="panel advanced-panel">
              <label class="inline"><input id="showAdvancedVars" type="checkbox"> Show misc/advanced vars</label>
              <h3>Variables</h3>
              <div class="table-scroll">
                <table id="varsTable">
                  <thead><tr><th>Key</th><th>Label</th><th>Value</th><th>Formula</th><th>Computed</th><th></th></tr></thead>
                  <tbody></tbody>
                </table>
              </div>
              <button id="addVarBtn" type="button">Add Variable</button>
              <h3>Macros</h3>
              <table id="macrosTable">
                <thead><tr><th>Name</th><th>Expression</th><th></th></tr></thead>
                <tbody></tbody>
              </table>
              <button id="addMacroBtn" type="button">Add Macro</button>
              <h3>Blocks</h3>
              <div id="blocksWrap"></div>
              <button id="addBlockBtn" type="button">Add Block</button>
            </section>
          </section>
        </section>

        <aside class="sheet-right">
          <section class="panel hp-area">
            <div class="panel-head">
              <h3>Health & Resources</h3>
              <span>Autosave enabled</span>
            </div>
            <div class="hp-mini-grid">
              <label class="hp-mini">HP Max <input id="hp_max" type="number"></label>
              <label class="hp-mini">Current HP <input id="hp_current" type="number"></label>
              <label class="hp-mini">Temp HP <input id="hp_temp" type="number"></label>
            </div>
            <div class="hp-adjust-row">
              <input id="hp_delta" type="number" value="0" min="0" step="1">
              <button id="hp_heal_btn" type="button">Heal</button>
              <button id="hp_dmg_btn" type="button">Damage</button>
            </div>
            <div class="death-saves">
              <div class="death-track">
                <span>Successes</span>
                <label><input type="checkbox" id="death_success_1"></label>
                <label><input type="checkbox" id="death_success_2"></label>
                <label><input type="checkbox" id="death_success_3"></label>
              </div>
              <div class="death-track">
                <span>Failures</span>
                <label><input type="checkbox" id="death_fail_1"></label>
                <label><input type="checkbox" id="death_fail_2"></label>
                <label><input type="checkbox" id="death_fail_3"></label>
              </div>
            </div>
          </section>

          <section class="panel quick-inventory">
            <div class="panel-head">
              <h3>Inventory</h3>
              <span id="inventoryCount">0 items</span>
            </div>
            <div id="inventorySummary"></div>
          </section>
        </aside>
      </div>
    </section>

    <section id="historyView" class="view history-view is-hidden">
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>Full Version History</h2>
            <p id="historySubtitle">Restorable snapshots for the current character.</p>
          </div>
          <button id="closeHistoryBtn" type="button">Back to Sheet</button>
        </div>
        <div id="fullVersionHistory" class="version-history-full"></div>
      </section>
    </section>
  </main>

  <script src="assets/app.js"></script>
</body>
</html>
