<?php

declare(strict_types=1);

require_once __DIR__ . '/lib/db.php';

header('Content-Type: application/json; charset=utf-8');

function json_input(): array
{
    $raw = file_get_contents('php://input') ?: '';
    if ($raw === '') {
        return [];
    }
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : [];
}

function respond(array $payload, int $code = 200): void
{
    http_response_code($code);
    echo json_encode($payload, JSON_UNESCAPED_SLASHES);
    exit;
}

function decode_sheet(?string $json): array
{
    $decoded = $json ? json_decode($json, true) : null;
    return is_array($decoded) ? $decoded : ['variables' => [], 'blocks' => [], 'macros' => []];
}

$pdo = db_connect();
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$action = $_GET['action'] ?? '';

if ($method === 'GET' && $action === 'bootstrap') {
    $systems = get_systems($pdo);
    $templates = [];
    $referenceOptions = [];
    $equipmentCatalog = [];

    foreach ($systems as $system) {
        $key = (string)$system['system_key'];
        $templates[$key] = get_templates_by_system($pdo, $key);
        $referenceOptions[$key] = get_reference_options_by_system($pdo, $key);
        $equipmentCatalog[$key] = get_equipment_catalog_by_system($pdo, $key);
    }

    $characters = $pdo->query('SELECT id, name, system_key, template_id, system_meta_json, sheet_json, updated_at FROM characters ORDER BY updated_at DESC')->fetchAll();
    respond([
        'ok' => true,
        'systems' => $systems,
        'templates' => $templates,
        'reference_options' => $referenceOptions,
        'equipment_catalog' => $equipmentCatalog,
        'characters' => $characters,
    ]);
}

if ($method === 'GET' && $action === 'character') {
    $id = (int)($_GET['id'] ?? 0);
    if ($id <= 0) {
        respond(['ok' => false, 'error' => 'Invalid character id.'], 400);
    }

    $stmt = $pdo->prepare('SELECT * FROM characters WHERE id = :id');
    $stmt->execute([':id' => $id]);
    $row = $stmt->fetch();
    if (!$row) {
        respond(['ok' => false, 'error' => 'Character not found.'], 404);
    }

    $row['sheet'] = decode_sheet($row['sheet_json']);
    $row['equipment'] = get_character_equipment($pdo, (int)$row['id']);
    unset($row['sheet_json']);
    respond(['ok' => true, 'character' => $row]);
}

if ($method === 'GET' && $action === 'character_versions') {
    $characterId = (int)($_GET['character_id'] ?? 0);
    if ($characterId <= 0) {
        respond(['ok' => false, 'error' => 'Invalid character id.'], 400);
    }

    respond(['ok' => true, 'versions' => list_character_versions($pdo, $characterId)]);
}

if ($method === 'GET' && $action === 'character_version') {
    $versionId = (int)($_GET['id'] ?? 0);
    if ($versionId <= 0) {
        respond(['ok' => false, 'error' => 'Invalid version id.'], 400);
    }

    $version = get_character_version($pdo, $versionId);
    if (!$version) {
        respond(['ok' => false, 'error' => 'Version not found.'], 404);
    }

    respond(['ok' => true, 'version' => $version]);
}

if ($method === 'POST' && $action === 'add_reference_option') {
    $in = json_input();
    $systemKey = trim((string)($in['system_key'] ?? 'dnd5e2014'));
    $type = trim((string)($in['option_type'] ?? ''));
    $name = trim((string)($in['name'] ?? ''));

    if (!in_array($type, ['race', 'background'], true)) {
        respond(['ok' => false, 'error' => 'Invalid option type.'], 400);
    }
    if ($name === '') {
        respond(['ok' => false, 'error' => 'Option name required.'], 400);
    }

    add_reference_option($pdo, $systemKey, $type, $name, true);
    respond(['ok' => true]);
}

if ($method === 'POST' && $action === 'add_equipment_catalog_item') {
    $in = json_input();
    $systemKey = trim((string)($in['system_key'] ?? 'dnd5e2014'));
    $item = is_array($in['item'] ?? null) ? $in['item'] : [];

    $name = trim((string)($item['name'] ?? ''));
    if ($name === '') {
        respond(['ok' => false, 'error' => 'Item name required.'], 400);
    }

    add_equipment_catalog_item($pdo, $systemKey, $item);
    respond(['ok' => true]);
}

if ($method === 'POST' && $action === 'create_character') {
    $in = json_input();
    $name = trim((string)($in['name'] ?? ''));
    $systemKey = trim((string)($in['system_key'] ?? 'dnd5e2014'));
    $templateId = (int)($in['template_id'] ?? 0);
    $use5eHelpers = (bool)($in['use_5e_helpers'] ?? false);

    if ($name === '') {
        respond(['ok' => false, 'error' => 'Character name is required.'], 400);
    }

    if ($templateId <= 0) {
        $stmt = $pdo->prepare('SELECT default_template_id FROM systems WHERE system_key = :system_key');
        $stmt->execute([':system_key' => $systemKey]);
        $templateId = (int)$stmt->fetchColumn();
    }

    $stmt = $pdo->prepare('SELECT template_json FROM templates WHERE id = :id');
    $stmt->execute([':id' => $templateId]);
    $templateJson = $stmt->fetchColumn();

    if (!$templateJson) {
        respond(['ok' => false, 'error' => 'Template not found.'], 404);
    }

    $sheet = decode_sheet((string)$templateJson);
    $meta = [
        'use_5e_helpers' => $use5eHelpers,
    ];

    $now = now_iso();
    $insert = $pdo->prepare('INSERT INTO characters (name, system_key, system_meta_json, template_id, sheet_json, created_at, updated_at)
        VALUES (:name, :system_key, :system_meta_json, :template_id, :sheet_json, :created_at, :updated_at)');
    $insert->execute([
        ':name' => $name,
        ':system_key' => $systemKey,
        ':system_meta_json' => json_encode($meta, JSON_UNESCAPED_SLASHES),
        ':template_id' => $templateId,
        ':sheet_json' => json_encode($sheet, JSON_UNESCAPED_SLASHES),
        ':created_at' => $now,
        ':updated_at' => $now,
    ]);

    respond(['ok' => true, 'id' => (int)$pdo->lastInsertId()]);
}

if ($method === 'POST' && $action === 'save_character') {
    $in = json_input();
    $id = (int)($in['id'] ?? 0);

    if ($id <= 0) {
        respond(['ok' => false, 'error' => 'Invalid character id.'], 400);
    }

    $name = trim((string)($in['name'] ?? ''));
    $systemKey = trim((string)($in['system_key'] ?? 'dnd5e2014'));
    $templateId = (int)($in['template_id'] ?? 0);
    $sheet = is_array($in['sheet'] ?? null) ? $in['sheet'] : ['variables' => [], 'blocks' => [], 'macros' => []];
    $meta = is_array($in['system_meta'] ?? null) ? $in['system_meta'] : [];
    $equipment = is_array($in['equipment'] ?? null) ? $in['equipment'] : [];
    $saveSource = trim((string)($in['save_source'] ?? 'manual'));
    if (!in_array($saveSource, ['manual', 'autosave', 'session', 'level_up'], true)) {
        $saveSource = 'manual';
    }
    $snapshotLabel = trim((string)($in['snapshot_label'] ?? ''));
    $createVersion = array_key_exists('create_version', $in)
        ? (bool)$in['create_version']
        : $saveSource !== 'autosave';

    if ($name === '') {
        respond(['ok' => false, 'error' => 'Character name is required.'], 400);
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
        ':id' => $id,
        ':name' => $name,
        ':system_key' => $systemKey,
        ':system_meta_json' => json_encode($meta, JSON_UNESCAPED_SLASHES),
        ':template_id' => $templateId,
        ':sheet_json' => json_encode($sheet, JSON_UNESCAPED_SLASHES),
        ':updated_at' => $now,
    ]);

    replace_character_equipment($pdo, $id, $equipment);

    $versionId = null;
    if ($createVersion || ($saveSource === 'autosave' && should_create_autosave_version($pdo, $id))) {
        $versionId = create_character_version($pdo, $id, $saveSource, $snapshotLabel);
    }

    respond(['ok' => true, 'version_id' => $versionId]);
}

if ($method === 'POST' && $action === 'create_character_snapshot') {
    $in = json_input();
    $characterId = (int)($in['character_id'] ?? 0);
    if ($characterId <= 0) {
        respond(['ok' => false, 'error' => 'Invalid character id.'], 400);
    }

    $source = trim((string)($in['save_source'] ?? 'manual'));
    if (!in_array($source, ['manual', 'autosave', 'session', 'level_up'], true)) {
        $source = 'manual';
    }
    $label = trim((string)($in['snapshot_label'] ?? ''));
    $versionId = create_character_version($pdo, $characterId, $source, $label);
    if (!$versionId) {
        respond(['ok' => false, 'error' => 'Character not found.'], 404);
    }

    respond(['ok' => true, 'version_id' => $versionId]);
}

if ($method === 'POST' && $action === 'restore_character_version') {
    $in = json_input();
    $versionId = (int)($in['version_id'] ?? 0);
    if ($versionId <= 0) {
        respond(['ok' => false, 'error' => 'Invalid version id.'], 400);
    }

    $characterId = restore_character_version($pdo, $versionId);
    if (!$characterId) {
        respond(['ok' => false, 'error' => 'Version not found or cannot be restored.'], 404);
    }

    respond(['ok' => true, 'character_id' => $characterId]);
}

if ($method === 'POST' && $action === 'duplicate_character_version') {
    $in = json_input();
    $versionId = (int)($in['version_id'] ?? 0);
    if ($versionId <= 0) {
        respond(['ok' => false, 'error' => 'Invalid version id.'], 400);
    }

    $characterId = duplicate_character_version($pdo, $versionId);
    if (!$characterId) {
        respond(['ok' => false, 'error' => 'Version not found or cannot be duplicated.'], 404);
    }

    respond(['ok' => true, 'character_id' => $characterId]);
}

respond(['ok' => false, 'error' => 'Unknown route.'], 404);
