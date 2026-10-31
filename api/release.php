<?php
/**
 * CipherSeal release service (PHP + SQLite) for shared cPanel hosting (Namecheap Stellar).
 *
 * Holds ONE random 256-bit key share per view-once / self-destruct item and
 * hands it out exactly once. It never receives the password, the content or
 * the encrypted file: only itemId, a password PROOF (auth) and the share.
 *
 *   POST {op:"register", itemId, auth, share, ttl, appOnly, reusable}  sender stores the share (create-only)
 *   POST {op:"verify",   itemId, auth}              password proof check; counts wrong tries
 *   POST {op:"claim",    itemId, auth}              releases the share ONCE, then deletes it
 *
 * Exactly-once is enforced by a SQLite BEGIN IMMEDIATE transaction: writers
 * are serialised, so two devices claiming at the same instant cannot both win.
 */
declare(strict_types=1);

const MAX_FAILS = 3;
const DEFAULT_TTL = 604800;          // 7 days
const MIN_TTL = 60;
const MAX_TTL = 31536000;            // 1 year
const PURGE_AFTER = 2592000;         // dead rows are deleted 30 days after they die (share is already gone)

header('Content-Type: application/json');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function out(int $status, array $body): void { http_response_code($status); echo json_encode($body); exit; }

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') out(405, ['error' => 'POST only']);
$raw = file_get_contents('php://input', false, null, 0, 4097);
if ($raw === false || strlen($raw) > 4096) out(413, ['error' => 'too large']);
$b = json_decode($raw, true);
if (!is_array($b)) out(400, ['error' => 'bad body']);

$op     = $b['op'] ?? '';
$itemId = $b['itemId'] ?? '';
$auth   = $b['auth'] ?? '';
if (!in_array($op, ['register', 'verify', 'claim'], true)) out(400, ['error' => 'bad op']);
if (!is_string($itemId) || !preg_match('/^[0-9a-f]{32}$/', $itemId)) out(400, ['error' => 'bad itemId']);
if (!is_string($auth) || !preg_match('/^[0-9a-f]{64}$/', $auth)) out(400, ['error' => 'bad auth']);

// ---- database location: outside the web root when possible, else api/data (blocked by .htaccess)
function dbPath(): string {
    $env = getenv('CS_DB_PATH');
    if ($env) return $env;
    $root = $_SERVER['DOCUMENT_ROOT'] ?? '';
    $home = $root ? dirname(rtrim($root, '/')) : '';
    if ($home && is_dir($home) && is_writable($home)) {
        $dir = $home . '/cipherseal_data';
        if (is_dir($dir) || @mkdir($dir, 0700, true)) return $dir . '/release.sqlite';
    }
    $dir = __DIR__ . '/data';
    if (!is_dir($dir)) @mkdir($dir, 0700, true);
    return $dir . '/release.sqlite';
}

try {
    $pdo = new PDO('sqlite:' . dbPath(), null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $pdo->exec('PRAGMA busy_timeout = 8000');
    $pdo->exec('CREATE TABLE IF NOT EXISTS items (
        item_id TEXT PRIMARY KEY, auth_hash TEXT NOT NULL, share TEXT,
        state TEXT NOT NULL DEFAULT "ok", fails INTEGER NOT NULL DEFAULT 0,
        created INTEGER NOT NULL, expires INTEGER NOT NULL, died INTEGER,
        app_only INTEGER NOT NULL DEFAULT 0, reusable INTEGER NOT NULL DEFAULT 0)');
    $cols = array_column($pdo->query('PRAGMA table_info(items)')->fetchAll(PDO::FETCH_ASSOC), 'name');   // upgrade older databases
    if (!in_array('app_only', $cols, true)) $pdo->exec('ALTER TABLE items ADD COLUMN app_only INTEGER NOT NULL DEFAULT 0');
    if (!in_array('reusable', $cols, true)) $pdo->exec('ALTER TABLE items ADD COLUMN reusable INTEGER NOT NULL DEFAULT 0');
    $pdo->exec('CREATE TABLE IF NOT EXISTS rl (k TEXT PRIMARY KEY, n INTEGER NOT NULL, w INTEGER NOT NULL)');
} catch (Throwable $e) {
    out(503, ['error' => 'server', 'message' => 'Release service storage is not available. Nothing was opened.']);
}

$now = time();

// ---- tiny per-IP rate limit (stops bulk registration / online password guessing floods)
function limited(PDO $pdo, string $op, int $now): bool {
    $lim = ['register' => [200, 3600], 'verify' => [300, 600], 'claim' => [300, 600]][$op];
    $win = intdiv($now, $lim[1]);
    $k = $op . '|' . ($_SERVER['REMOTE_ADDR'] ?? '?') . '|' . $win;
    $pdo->prepare('DELETE FROM rl WHERE w < ?')->execute([$win - 1]);
    $pdo->prepare('INSERT INTO rl (k,n,w) VALUES (?,1,?) ON CONFLICT(k) DO UPDATE SET n = n + 1')->execute([$k, $win]);
    $s = $pdo->prepare('SELECT n FROM rl WHERE k = ?'); $s->execute([$k]);
    return (int)$s->fetchColumn() > $lim[0];
}
if (limited($pdo, $op, $now)) out(429, ['error' => 'slow', 'message' => 'Too many requests from this network. Try again later.']);

try {
    if ($op === 'register') {
        $share = $b['share'] ?? '';
        if (!is_string($share) || strlen($share) !== 44 || !preg_match('#^[A-Za-z0-9+/]{43}=$#', $share)) out(400, ['error' => 'bad share']);
        $ttl = isset($b['ttl']) ? (int)$b['ttl'] : DEFAULT_TTL;
        $ttl = max(MIN_TTL, min(MAX_TTL, $ttl));
        $pdo->prepare('DELETE FROM items WHERE died IS NOT NULL AND died < ?')->execute([$now - PURGE_AFTER]);
        $pdo->prepare('DELETE FROM items WHERE state = "ok" AND expires < ?')->execute([$now - PURGE_AFTER]);
        try {
            $appOnly = !empty($b['appOnly']) ? 1 : 0;
            $reusable = (!empty($b['reusable']) && $appOnly) ? 1 : 0;      // reusable only makes sense for app-only protected items
            $pdo->prepare('INSERT INTO items (item_id, auth_hash, share, created, expires, app_only, reusable) VALUES (?,?,?,?,?,?,?)')
                ->execute([$itemId, hash('sha256', $auth), $share, $now, $now + $ttl, $appOnly, $reusable]);
        } catch (PDOException $e) {
            if (strpos($e->getMessage(), 'UNIQUE') !== false) out(409, ['error' => 'item already registered']);
            throw $e;
        }
        out(200, ['ok' => true, 'expires' => $now + $ttl]);
    }

    // verify / claim: one serialised write transaction
    $pdo->exec('BEGIN IMMEDIATE');
    $s = $pdo->prepare('SELECT * FROM items WHERE item_id = ?'); $s->execute([$itemId]);
    $row = $s->fetch(PDO::FETCH_ASSOC);
    $finish = function (int $st, array $body) use ($pdo) { $pdo->exec('COMMIT'); out($st, $body); };

    if (!$row) $finish(404, ['error' => 'unknown', 'message' => 'This item is not registered with the release service.']);
    if ($row['state'] === 'burned') $finish(410, ['error' => 'burned', 'message' => 'This item has already been opened and can never be opened again.']);
    if ($row['state'] === 'locked') $finish(423, ['error' => 'locked', 'message' => 'This item is locked after too many wrong passwords.']);
    if ($row['state'] === 'expired' || (int)$row['expires'] < $now) {
        $pdo->prepare('UPDATE items SET state="expired", share=NULL, died=COALESCE(died,?) WHERE item_id=?')->execute([$now, $itemId]);
        $finish(410, ['error' => 'expired', 'message' => 'This item has expired and can no longer be opened.']);
    }
    // Secure-app-only items: refuse (without counting a wrong password or using anything up) unless the request comes from the CipherSeal app.
    if ((int)$row['app_only'] === 1 && strpos($_SERVER['HTTP_USER_AGENT'] ?? '', 'CipherSealApp/') === false) {
        $finish(403, ['error' => 'apponly', 'message' => 'The sender made this item openable only in the CipherSeal Android app, which blocks screenshots and screen recording. Open it there.']);
    }
    if (!hash_equals($row['auth_hash'], hash('sha256', $auth))) {
        $n = (int)$row['fails'] + 1;
        if ($n >= MAX_FAILS) {
            $pdo->prepare('UPDATE items SET fails=?, state="locked", share=NULL, died=? WHERE item_id=?')->execute([$n, $now, $itemId]);
            $finish(423, ['error' => 'locked', 'fails' => $n, 'message' => 'Locked: 3 wrong passwords. This item is permanently damaged on every device.']);
        }
        $pdo->prepare('UPDATE items SET fails=? WHERE item_id=?')->execute([$n, $itemId]);
        $finish(403, ['error' => 'wrong', 'fails' => $n, 'left' => MAX_FAILS - $n]);
    }
    if ($op === 'verify') {
        $pdo->prepare('UPDATE items SET fails=0 WHERE item_id=?')->execute([$itemId]);
        $finish(200, ['ok' => true]);
    }
    // claim
    if ((int)$row['reusable'] === 1 && $row['share']) $finish(200, ['share' => $row['share']]);   // app-only protected item: viewable repeatedly inside the app
    if (!$row['share']) $finish(410, ['error' => 'burned', 'message' => 'This item has already been opened and can never be opened again.']);
    $pdo->prepare('UPDATE items SET share=NULL, state="burned", died=? WHERE item_id=?')->execute([$now, $itemId]);
    $finish(200, ['share' => $row['share']]);
} catch (Throwable $e) {
    try { $pdo->exec('ROLLBACK'); } catch (Throwable $x) { /* no open transaction */ }
    out(500, ['error' => 'server', 'message' => 'Release service error. Nothing was opened.']);
}
