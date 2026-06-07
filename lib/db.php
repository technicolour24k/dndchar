<?php

declare(strict_types=1);

function db_path(): string
{
    $override = getenv('DNDCHAR_DB_PATH');
    if (is_string($override) && trim($override) !== '') {
        return $override;
    }

    $localDir = __DIR__ . '/../data';
    if (is_dir($localDir) && is_writable($localDir)) {
        return $localDir . '/dndchar.sqlite';
    }

    return rtrim(sys_get_temp_dir(), '/\\') . DIRECTORY_SEPARATOR . 'dndchar.sqlite';
}

function db_connect(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $dbFile = db_path();
    $dbDir = dirname($dbFile);
    if (!is_dir($dbDir)) {
        mkdir($dbDir, 0777, true);
    }

    $pdo = new PDO('sqlite:' . $dbFile);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);

    db_bootstrap($pdo);
    return $pdo;
}

function now_iso(): string
{
    return gmdate('Y-m-d H:i:s');
}

function db_bootstrap(PDO $pdo): void
{
    $pdo->exec('CREATE TABLE IF NOT EXISTS systems (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        system_key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        version_label TEXT,
        description TEXT,
        default_template_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )');

    $pdo->exec('CREATE TABLE IF NOT EXISTS templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        system_key TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        template_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(system_key, name)
    )');

    $pdo->exec('CREATE TABLE IF NOT EXISTS characters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        system_key TEXT NOT NULL DEFAULT "dnd5e2014",
        system_meta_json TEXT NOT NULL DEFAULT "{}",
        template_id INTEGER,
        sheet_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )');

    $pdo->exec('CREATE TABLE IF NOT EXISTS reference_options (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        system_key TEXT NOT NULL,
        option_type TEXT NOT NULL,
        name TEXT NOT NULL,
        is_homebrew INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(system_key, option_type, name)
    )');

    $pdo->exec('CREATE TABLE IF NOT EXISTS character_equipment (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT "gear",
        quantity INTEGER NOT NULL DEFAULT 1,
        equipped INTEGER NOT NULL DEFAULT 1,
        ac_bonus INTEGER NOT NULL DEFAULT 0,
        str_bonus INTEGER NOT NULL DEFAULT 0,
        dex_bonus INTEGER NOT NULL DEFAULT 0,
        con_bonus INTEGER NOT NULL DEFAULT 0,
        int_bonus INTEGER NOT NULL DEFAULT 0,
        wis_bonus INTEGER NOT NULL DEFAULT 0,
        cha_bonus INTEGER NOT NULL DEFAULT 0,
        attack_ability TEXT NOT NULL DEFAULT "str",
        damage_dice TEXT NOT NULL DEFAULT "",
        proficient INTEGER NOT NULL DEFAULT 1,
        attack_text TEXT NOT NULL DEFAULT "",
        notes TEXT NOT NULL DEFAULT "",
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )');

    $pdo->exec('CREATE TABLE IF NOT EXISTS equipment_catalog (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        system_key TEXT NOT NULL,
        name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT "gear",
        ac_bonus INTEGER NOT NULL DEFAULT 0,
        str_bonus INTEGER NOT NULL DEFAULT 0,
        dex_bonus INTEGER NOT NULL DEFAULT 0,
        con_bonus INTEGER NOT NULL DEFAULT 0,
        int_bonus INTEGER NOT NULL DEFAULT 0,
        wis_bonus INTEGER NOT NULL DEFAULT 0,
        cha_bonus INTEGER NOT NULL DEFAULT 0,
        attack_ability TEXT NOT NULL DEFAULT "str",
        damage_dice TEXT NOT NULL DEFAULT "",
        proficient INTEGER NOT NULL DEFAULT 1,
        attack_text TEXT NOT NULL DEFAULT "",
        notes TEXT NOT NULL DEFAULT "",
        is_homebrew INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(system_key, name)
    )');

    $pdo->exec('CREATE TABLE IF NOT EXISTS character_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id INTEGER NOT NULL,
        version_source TEXT NOT NULL DEFAULT "manual",
        label TEXT NOT NULL DEFAULT "",
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL
    )');

    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_character_versions_character_created
        ON character_versions (character_id, created_at)');

    ensure_column($pdo, 'character_equipment', 'attack_ability', 'TEXT NOT NULL DEFAULT "str"');
    ensure_column($pdo, 'character_equipment', 'damage_dice', 'TEXT NOT NULL DEFAULT ""');
    ensure_column($pdo, 'character_equipment', 'proficient', 'INTEGER NOT NULL DEFAULT 1');
    ensure_column($pdo, 'equipment_catalog', 'attack_ability', 'TEXT NOT NULL DEFAULT "str"');
    ensure_column($pdo, 'equipment_catalog', 'damage_dice', 'TEXT NOT NULL DEFAULT ""');
    ensure_column($pdo, 'equipment_catalog', 'proficient', 'INTEGER NOT NULL DEFAULT 1');

    seed_defaults($pdo);
    try {
        seed_reference_options($pdo, 'dnd5e2014');
    } catch (PDOException $e) {
        // Keep app booting even when SQLite file locks occur.
    }
    try {
        seed_equipment_catalog($pdo, 'dnd5e2014');
    } catch (PDOException $e) {
        // Keep app booting even when SQLite file locks occur.
    }
}

function seed_defaults(PDO $pdo): void
{
    $existing = (int)$pdo->query('SELECT COUNT(*) FROM systems WHERE system_key = "dnd5e2014"')->fetchColumn();
    if ($existing > 0) {
        return;
    }

    $template = [
        'variables' => [
            ['key' => 'level', 'label' => 'Level', 'value' => 1, 'formula' => ''],
            ['key' => 'str', 'label' => 'STR', 'value' => 10, 'formula' => ''],
            ['key' => 'dex', 'label' => 'DEX', 'value' => 10, 'formula' => ''],
            ['key' => 'con', 'label' => 'CON', 'value' => 10, 'formula' => ''],
            ['key' => 'int', 'label' => 'INT', 'value' => 10, 'formula' => ''],
            ['key' => 'wis', 'label' => 'WIS', 'value' => 10, 'formula' => ''],
            ['key' => 'cha', 'label' => 'CHA', 'value' => 10, 'formula' => ''],
            ['key' => 'str_item_bonus', 'label' => 'STR Item Bonus', 'value' => 0, 'formula' => ''],
            ['key' => 'dex_item_bonus', 'label' => 'DEX Item Bonus', 'value' => 0, 'formula' => ''],
            ['key' => 'con_item_bonus', 'label' => 'CON Item Bonus', 'value' => 0, 'formula' => ''],
            ['key' => 'int_item_bonus', 'label' => 'INT Item Bonus', 'value' => 0, 'formula' => ''],
            ['key' => 'wis_item_bonus', 'label' => 'WIS Item Bonus', 'value' => 0, 'formula' => ''],
            ['key' => 'cha_item_bonus', 'label' => 'CHA Item Bonus', 'value' => 0, 'formula' => ''],
            ['key' => 'str_mod', 'label' => 'STR Mod', 'value' => 0, 'formula' => 'floor(((str + str_item_bonus) - 10) / 2)'],
            ['key' => 'dex_mod', 'label' => 'DEX Mod', 'value' => 0, 'formula' => 'floor(((dex + dex_item_bonus) - 10) / 2)'],
            ['key' => 'con_mod', 'label' => 'CON Mod', 'value' => 0, 'formula' => 'floor(((con + con_item_bonus) - 10) / 2)'],
            ['key' => 'int_mod', 'label' => 'INT Mod', 'value' => 0, 'formula' => 'floor(((int + int_item_bonus) - 10) / 2)'],
            ['key' => 'wis_mod', 'label' => 'WIS Mod', 'value' => 0, 'formula' => 'floor(((wis + wis_item_bonus) - 10) / 2)'],
            ['key' => 'cha_mod', 'label' => 'CHA Mod', 'value' => 0, 'formula' => 'floor(((cha + cha_item_bonus) - 10) / 2)'],
            ['key' => 'prof_bonus', 'label' => 'Proficiency Bonus', 'value' => 2, 'formula' => '2 + floor((level - 1) / 4)'],
            ['key' => 'ac', 'label' => 'Armor Class', 'value' => 10, 'formula' => ''],
            ['key' => 'initiative', 'label' => 'Initiative', 'value' => 0, 'formula' => 'dex_mod'],
            ['key' => 'speed', 'label' => 'Speed', 'value' => 30, 'formula' => ''],
            ['key' => 'hp_max', 'label' => 'HP Max', 'value' => 10, 'formula' => ''],
            ['key' => 'hp_current', 'label' => 'HP Current', 'value' => 10, 'formula' => ''],
            ['key' => 'hp_temp', 'label' => 'Temp HP', 'value' => 0, 'formula' => ''],
        ],
        'blocks' => [
            ['id' => 'combat', 'title' => 'Combat Core', 'content' => "AC, Initiative, Speed, HP, Temp HP"],
            ['id' => 'saves', 'title' => 'Saving Throws', 'content' => "STR, DEX, CON, INT, WIS, CHA saves"],
            ['id' => 'skills', 'title' => 'Skills', 'content' => "Acrobatics, Arcana, Athletics, History, Insight, etc."],
            ['id' => 'attacks', 'title' => 'Attacks', 'content' => "Name | To Hit | Damage | Notes"],
            ['id' => 'spellcasting', 'title' => 'Spellcasting', 'content' => "Spell attack, save DC, prepared spells, notes"],
            ['id' => 'spell_slots', 'title' => 'Spell Slots', 'content' => "L1: 0/0, L2: 0/0 ... or enable spell points"],
            ['id' => 'inventory', 'title' => 'Equipment / Inventory', 'content' => "Item | Qty | Weight | Notes"],
            ['id' => 'conditions', 'title' => 'Conditions / Toggles', 'content' => "Rage [ ], Bless [ ], Concentrating [ ]"],
            ['id' => 'death_saves', 'title' => 'Death Saves (Optional)', 'content' => "Successes: 0/3, Failures: 0/3"],
        ],
        'macros' => [
            ['name' => 'Initiative', 'expr' => '1d20 + dex_mod'],
            ['name' => 'STR Save', 'expr' => '1d20 + str_mod + prof_bonus'],
            ['name' => 'Perception', 'expr' => '1d20 + wis_mod'],
        ],
    ];

    $now = now_iso();

    $insertTemplate = $pdo->prepare('INSERT INTO templates (system_key, name, description, template_json, created_at, updated_at)
        VALUES (:system_key, :name, :description, :template_json, :created_at, :updated_at)');
    $insertTemplate->execute([
        ':system_key' => 'dnd5e2014',
        ':name' => 'Default 5E 2014 Sheet',
        ':description' => 'Editable D&D 5E 2014 starter template. Content is user-editable.',
        ':template_json' => json_encode($template, JSON_UNESCAPED_SLASHES),
        ':created_at' => $now,
        ':updated_at' => $now,
    ]);

    $templateId = (int)$pdo->lastInsertId();

    $insertSystem = $pdo->prepare('INSERT INTO systems (system_key, name, version_label, description, default_template_id, created_at, updated_at)
        VALUES (:system_key, :name, :version_label, :description, :default_template_id, :created_at, :updated_at)');
    $insertSystem->execute([
        ':system_key' => 'dnd5e2014',
        ':name' => 'D&D 5E',
        ':version_label' => '2014',
        ':description' => 'Default 5E 2014 setup for a system-agnostic character sheet app.',
        ':default_template_id' => $templateId,
        ':created_at' => $now,
        ':updated_at' => $now,
    ]);
}

function seed_reference_options(PDO $pdo, string $systemKey): void
{
    $races = [
        'Dragonborn', 'Dwarf', 'Elf', 'Gnome', 'Half-Elf', 'Halfling',
        'Half-Orc', 'Human', 'Tiefling',
    ];

    $backgrounds = [
        'Acolyte', 'Charlatan', 'Criminal', 'Entertainer', 'Folk Hero',
        'Guild Artisan', 'Hermit', 'Noble', 'Outlander', 'Sage',
        'Sailor', 'Soldier', 'Urchin',
    ];

    $insert = $pdo->prepare('INSERT OR IGNORE INTO reference_options
        (system_key, option_type, name, is_homebrew, created_at, updated_at)
        VALUES (:system_key, :option_type, :name, :is_homebrew, :created_at, :updated_at)');

    $now = now_iso();
    foreach ($races as $race) {
        $insert->execute([
            ':system_key' => $systemKey,
            ':option_type' => 'race',
            ':name' => $race,
            ':is_homebrew' => 0,
            ':created_at' => $now,
            ':updated_at' => $now,
        ]);
    }

    foreach ($backgrounds as $background) {
        $insert->execute([
            ':system_key' => $systemKey,
            ':option_type' => 'background',
            ':name' => $background,
            ':is_homebrew' => 0,
            ':created_at' => $now,
            ':updated_at' => $now,
        ]);
    }
}

function add_reference_option(PDO $pdo, string $systemKey, string $type, string $name, bool $isHomebrew = true): void
{
    $insert = $pdo->prepare('INSERT OR IGNORE INTO reference_options
        (system_key, option_type, name, is_homebrew, created_at, updated_at)
        VALUES (:system_key, :option_type, :name, :is_homebrew, :created_at, :updated_at)');

    $now = now_iso();
    $insert->execute([
        ':system_key' => $systemKey,
        ':option_type' => $type,
        ':name' => $name,
        ':is_homebrew' => $isHomebrew ? 1 : 0,
        ':created_at' => $now,
        ':updated_at' => $now,
    ]);
}

function get_reference_options_by_system(PDO $pdo, string $systemKey): array
{
    $stmt = $pdo->prepare('SELECT option_type, name, is_homebrew
        FROM reference_options
        WHERE system_key = :system_key
        ORDER BY option_type ASC, name ASC');
    $stmt->execute([':system_key' => $systemKey]);

    $out = ['race' => [], 'background' => []];
    foreach ($stmt->fetchAll() as $row) {
        $type = (string)$row['option_type'];
        if (!isset($out[$type])) {
            $out[$type] = [];
        }
        $out[$type][] = [
            'name' => (string)$row['name'],
            'is_homebrew' => (int)$row['is_homebrew'] === 1,
        ];
    }
    return $out;
}

function get_templates_by_system(PDO $pdo, string $systemKey): array
{
    $stmt = $pdo->prepare('SELECT id, system_key, name, description, template_json FROM templates WHERE system_key = :system_key ORDER BY id ASC');
    $stmt->execute([':system_key' => $systemKey]);
    return $stmt->fetchAll();
}

function get_systems(PDO $pdo): array
{
    return $pdo->query('SELECT id, system_key, name, version_label, description, default_template_id FROM systems ORDER BY name ASC')->fetchAll();
}

function ensure_column(PDO $pdo, string $table, string $column, string $definition): void
{
    $cols = $pdo->query("PRAGMA table_info($table)")->fetchAll();
    foreach ($cols as $c) {
        if ((string)($c['name'] ?? '') === $column) {
            return;
        }
    }
    $pdo->exec("ALTER TABLE $table ADD COLUMN $column $definition");
}

function seed_equipment_catalog(PDO $pdo, string $systemKey): void
{
    $items = [
        ['Leather Armor', 'armor', 1, 0, 0, 0, 0, 0, 0, 'str', '', 0, '', 'Light armor'],
        ['Chain Mail', 'armor', 6, 0, 0, 0, 0, 0, 0, 'str', '', 0, '', 'Heavy armor'],
        ['Shield', 'shield', 2, 0, 0, 0, 0, 0, 0, 'str', '', 0, '', 'Shield bonus to AC'],
        ['Longsword', 'weapon', 0, 0, 0, 0, 0, 0, 0, 'str', '1d8', 1, '', 'Versatile (1d10)'],
        ['Shortbow', 'weapon', 0, 0, 0, 0, 0, 0, 0, 'dex', '1d6', 1, '', 'Range 80/320'],
        ['Dagger', 'weapon', 0, 0, 0, 0, 0, 0, 0, 'dex', '1d4', 1, '', 'Finesse, light, thrown'],
        ['Cloak of Protection', 'wondrous', 1, 0, 0, 0, 0, 0, 0, 'str', '', 0, '', '+1 AC, +1 saves (track saves manually)'],
        ['Gauntlets of Ogre Power', 'wondrous', 0, 2, 0, 0, 0, 0, 0, 'str', '', 0, '', '+2 STR bonus in this app'],
        ['Amulet of Health', 'wondrous', 0, 0, 0, 2, 0, 0, 0, 'str', '', 0, '', '+2 CON bonus in this app'],
        ['Thieves\' Tools', 'gear', 0, 0, 0, 0, 0, 0, 0, 'dex', '', 0, '', 'Tool proficiency utility'],
        ['Rope, Hempen (50 ft)', 'gear', 0, 0, 0, 0, 0, 0, 0, 'str', '', 0, '', 'Adventuring gear'],
        ['Potion of Healing', 'consumable', 0, 0, 0, 0, 0, 0, 0, 'str', '2d4+2', 0, 'Healing item', 'Consumable'],
    ];

    $ins = $pdo->prepare('INSERT OR IGNORE INTO equipment_catalog (
        system_key, name, category, ac_bonus, str_bonus, dex_bonus, con_bonus, int_bonus, wis_bonus, cha_bonus,
        attack_ability, damage_dice, proficient, attack_text, notes, is_homebrew, created_at, updated_at
    ) VALUES (
        :system_key, :name, :category, :ac_bonus, :str_bonus, :dex_bonus, :con_bonus, :int_bonus, :wis_bonus, :cha_bonus,
        :attack_ability, :damage_dice, :proficient, :attack_text, :notes, :is_homebrew, :created_at, :updated_at
    )');

    $now = now_iso();
    foreach ($items as $it) {
        $ins->execute([
            ':system_key' => $systemKey,
            ':name' => $it[0],
            ':category' => $it[1],
            ':ac_bonus' => $it[2],
            ':str_bonus' => $it[3],
            ':dex_bonus' => $it[4],
            ':con_bonus' => $it[5],
            ':int_bonus' => $it[6],
            ':wis_bonus' => $it[7],
            ':cha_bonus' => $it[8],
            ':attack_ability' => $it[9],
            ':damage_dice' => $it[10],
            ':proficient' => $it[11],
            ':attack_text' => $it[12],
            ':notes' => $it[13],
            ':is_homebrew' => 0,
            ':created_at' => $now,
            ':updated_at' => $now,
        ]);
    }
}

function get_equipment_catalog_by_system(PDO $pdo, string $systemKey): array
{
    $stmt = $pdo->prepare('SELECT id, system_key, name, category, ac_bonus, str_bonus, dex_bonus, con_bonus, int_bonus, wis_bonus, cha_bonus,
        attack_ability, damage_dice, proficient, attack_text, notes, is_homebrew
        FROM equipment_catalog
        WHERE system_key = :system_key
        ORDER BY name ASC');
    $stmt->execute([':system_key' => $systemKey]);
    return $stmt->fetchAll();
}

function add_equipment_catalog_item(PDO $pdo, string $systemKey, array $item): void
{
    $name = trim((string)($item['name'] ?? ''));
    if ($name === '') {
        return;
    }

    $ins = $pdo->prepare('INSERT OR IGNORE INTO equipment_catalog (
        system_key, name, category, ac_bonus, str_bonus, dex_bonus, con_bonus, int_bonus, wis_bonus, cha_bonus,
        attack_ability, damage_dice, proficient, attack_text, notes, is_homebrew, created_at, updated_at
    ) VALUES (
        :system_key, :name, :category, :ac_bonus, :str_bonus, :dex_bonus, :con_bonus, :int_bonus, :wis_bonus, :cha_bonus,
        :attack_ability, :damage_dice, :proficient, :attack_text, :notes, :is_homebrew, :created_at, :updated_at
    )');

    $now = now_iso();
    $ins->execute([
        ':system_key' => $systemKey,
        ':name' => $name,
        ':category' => trim((string)($item['category'] ?? 'gear')) ?: 'gear',
        ':ac_bonus' => (int)($item['ac_bonus'] ?? 0),
        ':str_bonus' => (int)($item['str_bonus'] ?? 0),
        ':dex_bonus' => (int)($item['dex_bonus'] ?? 0),
        ':con_bonus' => (int)($item['con_bonus'] ?? 0),
        ':int_bonus' => (int)($item['int_bonus'] ?? 0),
        ':wis_bonus' => (int)($item['wis_bonus'] ?? 0),
        ':cha_bonus' => (int)($item['cha_bonus'] ?? 0),
        ':attack_ability' => trim((string)($item['attack_ability'] ?? 'str')) ?: 'str',
        ':damage_dice' => trim((string)($item['damage_dice'] ?? '')),
        ':proficient' => !empty($item['proficient']) ? 1 : 0,
        ':attack_text' => trim((string)($item['attack_text'] ?? '')),
        ':notes' => trim((string)($item['notes'] ?? '')),
        ':is_homebrew' => 1,
        ':created_at' => $now,
        ':updated_at' => $now,
    ]);
}

function get_character_equipment(PDO $pdo, int $characterId): array
{
    $stmt = $pdo->prepare('SELECT id, character_id, name, category, quantity, equipped, ac_bonus,
        str_bonus, dex_bonus, con_bonus, int_bonus, wis_bonus, cha_bonus,
        attack_ability, damage_dice, proficient, attack_text, notes, sort_order
        FROM character_equipment
        WHERE character_id = :character_id
        ORDER BY sort_order ASC, id ASC');
    $stmt->execute([':character_id' => $characterId]);
    return $stmt->fetchAll();
}

function replace_character_equipment(PDO $pdo, int $characterId, array $rows): void
{
    $pdo->beginTransaction();
    try {
        $del = $pdo->prepare('DELETE FROM character_equipment WHERE character_id = :character_id');
        $del->execute([':character_id' => $characterId]);

        $ins = $pdo->prepare('INSERT INTO character_equipment (
            character_id, name, category, quantity, equipped, ac_bonus,
            str_bonus, dex_bonus, con_bonus, int_bonus, wis_bonus, cha_bonus,
            attack_ability, damage_dice, proficient, attack_text, notes, sort_order, created_at, updated_at
        ) VALUES (
            :character_id, :name, :category, :quantity, :equipped, :ac_bonus,
            :str_bonus, :dex_bonus, :con_bonus, :int_bonus, :wis_bonus, :cha_bonus,
            :attack_ability, :damage_dice, :proficient, :attack_text, :notes, :sort_order, :created_at, :updated_at
        )');

        $now = now_iso();
        $sort = 0;
        foreach ($rows as $row) {
            $name = trim((string)($row['name'] ?? ''));
            if ($name === '') {
                continue;
            }

            $ins->execute([
                ':character_id' => $characterId,
                ':name' => $name,
                ':category' => trim((string)($row['category'] ?? 'gear')) ?: 'gear',
                ':quantity' => max(0, (int)($row['quantity'] ?? 1)),
                ':equipped' => !empty($row['equipped']) ? 1 : 0,
                ':ac_bonus' => (int)($row['ac_bonus'] ?? 0),
                ':str_bonus' => (int)($row['str_bonus'] ?? 0),
                ':dex_bonus' => (int)($row['dex_bonus'] ?? 0),
                ':con_bonus' => (int)($row['con_bonus'] ?? 0),
                ':int_bonus' => (int)($row['int_bonus'] ?? 0),
                ':wis_bonus' => (int)($row['wis_bonus'] ?? 0),
                ':cha_bonus' => (int)($row['cha_bonus'] ?? 0),
                ':attack_ability' => trim((string)($row['attack_ability'] ?? 'str')) ?: 'str',
                ':damage_dice' => trim((string)($row['damage_dice'] ?? '')),
                ':proficient' => !empty($row['proficient']) ? 1 : 0,
                ':attack_text' => trim((string)($row['attack_text'] ?? '')),
                ':notes' => trim((string)($row['notes'] ?? '')),
                ':sort_order' => $sort++,
                ':created_at' => $now,
                ':updated_at' => $now,
            ]);
        }

        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }
}

function get_character_row(PDO $pdo, int $characterId): ?array
{
    $stmt = $pdo->prepare('SELECT * FROM characters WHERE id = :id');
    $stmt->execute([':id' => $characterId]);
    $row = $stmt->fetch();
    return is_array($row) ? $row : null;
}

function build_character_snapshot(PDO $pdo, int $characterId): ?array
{
    $row = get_character_row($pdo, $characterId);
    if (!$row) {
        return null;
    }

    return [
        'id' => (int)$row['id'],
        'name' => (string)$row['name'],
        'system_key' => (string)$row['system_key'],
        'system_meta' => json_decode((string)$row['system_meta_json'], true) ?: [],
        'template_id' => (int)($row['template_id'] ?? 0),
        'sheet' => json_decode((string)$row['sheet_json'], true) ?: ['variables' => [], 'blocks' => [], 'macros' => []],
        'equipment' => get_character_equipment($pdo, $characterId),
        'created_at' => (string)$row['created_at'],
        'updated_at' => (string)$row['updated_at'],
    ];
}

function create_character_version(PDO $pdo, int $characterId, string $source = 'manual', string $label = ''): ?int
{
    $snapshot = build_character_snapshot($pdo, $characterId);
    if (!$snapshot) {
        return null;
    }

    $source = in_array($source, ['manual', 'autosave', 'session', 'level_up', 'restore'], true) ? $source : 'manual';
    $label = trim($label);
    if ($label === '') {
        $label = ucfirst(str_replace('_', ' ', $source));
    }

    $stmt = $pdo->prepare('INSERT INTO character_versions
        (character_id, version_source, label, snapshot_json, created_at)
        VALUES (:character_id, :version_source, :label, :snapshot_json, :created_at)');
    $stmt->execute([
        ':character_id' => $characterId,
        ':version_source' => $source,
        ':label' => $label,
        ':snapshot_json' => json_encode($snapshot, JSON_UNESCAPED_SLASHES),
        ':created_at' => now_iso(),
    ]);

    return (int)$pdo->lastInsertId();
}

function should_create_autosave_version(PDO $pdo, int $characterId): bool
{
    $stmt = $pdo->prepare('SELECT created_at FROM character_versions
        WHERE character_id = :character_id AND version_source = "autosave"
        ORDER BY created_at DESC LIMIT 1');
    $stmt->execute([':character_id' => $characterId]);
    $last = $stmt->fetchColumn();
    if (!is_string($last) || $last === '') {
        return true;
    }

    return strtotime($last . ' UTC') <= time() - 300;
}

function list_character_versions(PDO $pdo, int $characterId): array
{
    $stmt = $pdo->prepare('SELECT id, character_id, version_source, label, created_at
        FROM character_versions
        WHERE character_id = :character_id
        ORDER BY created_at DESC, id DESC');
    $stmt->execute([':character_id' => $characterId]);
    return $stmt->fetchAll();
}

function get_character_version(PDO $pdo, int $versionId): ?array
{
    $stmt = $pdo->prepare('SELECT * FROM character_versions WHERE id = :id');
    $stmt->execute([':id' => $versionId]);
    $row = $stmt->fetch();
    if (!$row) {
        return null;
    }
    $row['snapshot'] = json_decode((string)$row['snapshot_json'], true) ?: [];
    unset($row['snapshot_json']);
    return $row;
}

function restore_character_version(PDO $pdo, int $versionId): ?int
{
    $version = get_character_version($pdo, $versionId);
    if (!$version || !is_array($version['snapshot'] ?? null)) {
        return null;
    }

    $snapshot = $version['snapshot'];
    $characterId = (int)($version['character_id'] ?? 0);
    if ($characterId <= 0 || !get_character_row($pdo, $characterId)) {
        return null;
    }

    $now = now_iso();
    $stmt = $pdo->prepare('UPDATE characters SET
        name = :name,
        system_key = :system_key,
        system_meta_json = :system_meta_json,
        template_id = :template_id,
        sheet_json = :sheet_json,
        updated_at = :updated_at
        WHERE id = :id');
    $stmt->execute([
        ':id' => $characterId,
        ':name' => trim((string)($snapshot['name'] ?? 'Restored Character')) ?: 'Restored Character',
        ':system_key' => trim((string)($snapshot['system_key'] ?? 'dnd5e2014')) ?: 'dnd5e2014',
        ':system_meta_json' => json_encode(is_array($snapshot['system_meta'] ?? null) ? $snapshot['system_meta'] : [], JSON_UNESCAPED_SLASHES),
        ':template_id' => (int)($snapshot['template_id'] ?? 0),
        ':sheet_json' => json_encode(is_array($snapshot['sheet'] ?? null) ? $snapshot['sheet'] : ['variables' => [], 'blocks' => [], 'macros' => []], JSON_UNESCAPED_SLASHES),
        ':updated_at' => $now,
    ]);

    replace_character_equipment($pdo, $characterId, is_array($snapshot['equipment'] ?? null) ? $snapshot['equipment'] : []);
    create_character_version($pdo, $characterId, 'restore', 'Restored from version #' . $versionId);
    return $characterId;
}

function duplicate_character_version(PDO $pdo, int $versionId): ?int
{
    $version = get_character_version($pdo, $versionId);
    if (!$version || !is_array($version['snapshot'] ?? null)) {
        return null;
    }

    $snapshot = $version['snapshot'];
    $now = now_iso();
    $name = trim((string)($snapshot['name'] ?? 'Character')) ?: 'Character';
    $stmt = $pdo->prepare('INSERT INTO characters
        (name, system_key, system_meta_json, template_id, sheet_json, created_at, updated_at)
        VALUES (:name, :system_key, :system_meta_json, :template_id, :sheet_json, :created_at, :updated_at)');
    $stmt->execute([
        ':name' => $name . ' (version copy)',
        ':system_key' => trim((string)($snapshot['system_key'] ?? 'dnd5e2014')) ?: 'dnd5e2014',
        ':system_meta_json' => json_encode(is_array($snapshot['system_meta'] ?? null) ? $snapshot['system_meta'] : [], JSON_UNESCAPED_SLASHES),
        ':template_id' => (int)($snapshot['template_id'] ?? 0),
        ':sheet_json' => json_encode(is_array($snapshot['sheet'] ?? null) ? $snapshot['sheet'] : ['variables' => [], 'blocks' => [], 'macros' => []], JSON_UNESCAPED_SLASHES),
        ':created_at' => $now,
        ':updated_at' => $now,
    ]);

    $newId = (int)$pdo->lastInsertId();
    replace_character_equipment($pdo, $newId, is_array($snapshot['equipment'] ?? null) ? $snapshot['equipment'] : []);
    create_character_version($pdo, $newId, 'manual', 'Created from version #' . $versionId);
    return $newId;
}



