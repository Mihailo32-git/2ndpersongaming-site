<?php
/**
 * PF2e Builder API — accounts and character storage.
 * All responses are JSON. POST requests must send the header "X-PF2E: 1" (blocks cross-site form posts).
 * The database tables are created on the first request, so setting up only needs an empty database and config.php.
 *
 * Routes (?r=...):
 *   GET  status                 is the server set up, can people sign up, can it send email
 *   GET  me                     current user or null
 *   POST register {email,name,password[,invite]}
 *   POST login    {email,password}
 *   POST logout
 *   POST forgot   {email}                    email a password-reset link (always answers ok)
 *   POST reset    {token,password}           set a new password from that link, logs you in
 *   POST account  {name?, current?, password?}   change display name and/or password
 *   POST delete_account {password}           delete the account and all its characters
 *   GET  characters             list of your characters
 *   GET  character&id=N         one character (build + state + version)
 *   POST character {id?,name,build,state?,version?,force?}  create or update (state only replaced when sent);
 *                                            409 if another device saved a newer version since `version`
 *   POST character_state {id,state}         save live sheet state only
 *   POST delete {id}
 *   POST share {id,on}          turn a read-only share link on/off
 *   GET  shared&token=T         read-only shared character
 */
declare(strict_types=1);

// Where app/ (config.php, sessions) lives. Keep it outside public_html. Options, in order:
//  1. api/app-path.php that returns the absolute path, e.g. <?php return '/home/u123/domains/example.com/pf2e-app';
//  2. the PF2E_APP_DIR environment variable
//  3. ../../app relative to this file
$appDir = is_file(__DIR__ . '/app-path.php') ? (require __DIR__ . '/app-path.php') : (getenv('PF2E_APP_DIR') ?: dirname(__DIR__, 2) . '/app');

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

function fail(int $code, string $msg, array $extra = []): never {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => $msg] + $extra, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
function ok(array $data): never {
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

if (!is_file("$appDir/config.php")) {
    // Not set up yet: the site keeps working with characters saved in the browser.
    if (($_GET['r'] ?? '') === 'status') ok(['configured' => false]);
    fail(503, 'Accounts are not set up on this server yet');
}
$config = require "$appDir/config.php";

// Sessions: kept in app/sessions for 60 days, so players stay logged in on their tablets.
$https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
$lifetime = 60 * 60 * 24 * 60;
$sessDir = "$appDir/sessions";
if (!is_dir($sessDir)) @mkdir($sessDir, 0700, true);
if (is_dir($sessDir) && is_writable($sessDir)) session_save_path($sessDir);
ini_set('session.gc_maxlifetime', (string)$lifetime);
ini_set('session.use_strict_mode', '1');
session_set_cookie_params(['lifetime' => $lifetime, 'path' => '/', 'secure' => $https, 'httponly' => true, 'samesite' => 'Lax']);
session_name('pf2e_sid');
session_start();
// Keep the cookie alive while the player keeps using the site.
if (!empty($_SESSION['uid']) && (empty($_SESSION['renewed']) || $_SESSION['renewed'] < time() - 86400)) {
    $_SESSION['renewed'] = time();
    setcookie(session_name(), session_id(), ['expires' => time() + $lifetime, 'path' => '/', 'secure' => $https, 'httponly' => true, 'samesite' => 'Lax']);
}

function isSqlite(): bool { global $config; return str_starts_with((string)$config['db_dsn'], 'sqlite:'); }
function db(): PDO {
    static $pdo = null;
    global $config;
    if ($pdo) return $pdo;
    try {
        $pdo = new PDO($config['db_dsn'], $config['db_user'] ?? null, $config['db_pass'] ?? null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
    } catch (PDOException $e) {
        error_log('PF2e API DB error: ' . $e->getMessage());
        fail(500, 'Database connection failed');
    }
    if (isSqlite()) $pdo->exec('PRAGMA foreign_keys = ON');
    ensureSchema($pdo);
    return $pdo;
}

/** Creates or upgrades the tables. Schema 2: character versions, password resets, attempt kinds. Schema 3: parties. Schema 4: saved encounters. Schema 5: homebrew (GM's own creatures). */
function ensureSchema(PDO $pdo): void {
    $want = '5';
    try {
        $v = $pdo->query("SELECT v FROM app_meta WHERE k = 'schema'")->fetchColumn();
        if ($v === $want) return;
    } catch (PDOException $e) { /* first run */ }
    $lite = isSqlite();
    $ddl = $lite ? [
        "CREATE TABLE IF NOT EXISTS app_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', password_hash TEXT NOT NULL, created_at TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS characters (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL DEFAULT '', level INTEGER NOT NULL DEFAULT 1, class TEXT NOT NULL DEFAULT '', ancestry TEXT NOT NULL DEFAULT '', heritage TEXT NOT NULL DEFAULT '', build TEXT NOT NULL, state TEXT NOT NULL, share_token TEXT NULL UNIQUE, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
        "CREATE INDEX IF NOT EXISTS idx_user ON characters(user_id)",
        "CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'login', attempted_at TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS password_resets (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS parties (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL DEFAULT '', code TEXT NOT NULL UNIQUE, locked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
        "CREATE INDEX IF NOT EXISTS idx_party_owner ON parties(owner_id)",
        "CREATE TABLE IF NOT EXISTS party_members (party_id INTEGER NOT NULL REFERENCES parties(id) ON DELETE CASCADE, character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE, joined_at TEXT NOT NULL, PRIMARY KEY (party_id, character_id))",
        "CREATE INDEX IF NOT EXISTS idx_member_char ON party_members(character_id)",
        "CREATE TABLE IF NOT EXISTS encounters (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (user_id, id))",
        "CREATE TABLE IF NOT EXISTS homebrew (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'creature', name TEXT NOT NULL DEFAULT '', data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (user_id, id))",
    ] : [
        "CREATE TABLE IF NOT EXISTS app_meta (k VARCHAR(40) NOT NULL PRIMARY KEY, v VARCHAR(255) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        "CREATE TABLE IF NOT EXISTS users (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, email VARCHAR(190) NOT NULL UNIQUE, name VARCHAR(100) NOT NULL DEFAULT '', password_hash VARCHAR(255) NOT NULL, created_at DATETIME NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
        "CREATE TABLE IF NOT EXISTS characters (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, user_id INT UNSIGNED NOT NULL, name VARCHAR(120) NOT NULL DEFAULT '', level TINYINT UNSIGNED NOT NULL DEFAULT 1, class VARCHAR(60) NOT NULL DEFAULT '', ancestry VARCHAR(80) NOT NULL DEFAULT '', heritage VARCHAR(80) NOT NULL DEFAULT '', build MEDIUMTEXT NOT NULL, state MEDIUMTEXT NOT NULL, share_token VARCHAR(40) NULL UNIQUE, version INT UNSIGNED NOT NULL DEFAULT 1, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, INDEX idx_user (user_id), CONSTRAINT fk_char_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
        "CREATE TABLE IF NOT EXISTS login_attempts (ip VARCHAR(45) NOT NULL, kind VARCHAR(10) NOT NULL DEFAULT 'login', attempted_at DATETIME NOT NULL, INDEX idx_ip_time (ip, attempted_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        "CREATE TABLE IF NOT EXISTS password_resets (token_hash CHAR(64) NOT NULL PRIMARY KEY, user_id INT UNSIGNED NOT NULL, expires_at DATETIME NOT NULL, INDEX idx_reset_user (user_id), CONSTRAINT fk_reset_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        "CREATE TABLE IF NOT EXISTS parties (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, owner_id INT UNSIGNED NOT NULL, name VARCHAR(100) NOT NULL DEFAULT '', code CHAR(6) NOT NULL UNIQUE, locked TINYINT(1) NOT NULL DEFAULT 0, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, INDEX idx_party_owner (owner_id), CONSTRAINT fk_party_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
        "CREATE TABLE IF NOT EXISTS party_members (party_id INT UNSIGNED NOT NULL, character_id INT UNSIGNED NOT NULL, joined_at DATETIME NOT NULL, PRIMARY KEY (party_id, character_id), INDEX idx_member_char (character_id), CONSTRAINT fk_pm_party FOREIGN KEY (party_id) REFERENCES parties(id) ON DELETE CASCADE, CONSTRAINT fk_pm_char FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        "CREATE TABLE IF NOT EXISTS encounters (user_id INT UNSIGNED NOT NULL, id VARCHAR(40) NOT NULL, name VARCHAR(120) NOT NULL DEFAULT '', summary VARCHAR(255) NOT NULL DEFAULT '', data MEDIUMTEXT NOT NULL, version INT UNSIGNED NOT NULL DEFAULT 1, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, PRIMARY KEY (user_id, id), INDEX idx_enc_updated (user_id, updated_at), CONSTRAINT fk_enc_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
        "CREATE TABLE IF NOT EXISTS homebrew (user_id INT UNSIGNED NOT NULL, id VARCHAR(40) NOT NULL, kind VARCHAR(20) NOT NULL DEFAULT 'creature', name VARCHAR(120) NOT NULL DEFAULT '', data MEDIUMTEXT NOT NULL, version INT UNSIGNED NOT NULL DEFAULT 1, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, PRIMARY KEY (user_id, id), CONSTRAINT fk_hb_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
    ];
    foreach ($ddl as $q) $pdo->exec($q);
    // Upgrades for databases made from the first schema.sql
    $hasCol = function (string $table, string $col) use ($pdo): bool {
        try { $pdo->query("SELECT $col FROM $table LIMIT 1"); return true; } catch (PDOException $e) { return false; }
    };
    if (!$hasCol('characters', 'version')) $pdo->exec($lite ? "ALTER TABLE characters ADD COLUMN version INTEGER NOT NULL DEFAULT 1" : "ALTER TABLE characters ADD COLUMN version INT UNSIGNED NOT NULL DEFAULT 1");
    if (!$hasCol('login_attempts', 'kind')) $pdo->exec($lite ? "ALTER TABLE login_attempts ADD COLUMN kind TEXT NOT NULL DEFAULT 'login'" : "ALTER TABLE login_attempts ADD COLUMN kind VARCHAR(10) NOT NULL DEFAULT 'login'");
    $pdo->prepare($lite ? "INSERT OR REPLACE INTO app_meta (k, v) VALUES ('schema', ?)" : "REPLACE INTO app_meta (k, v) VALUES ('schema', ?)")->execute([$want]);
}

function now(int $offset = 0): string { return gmdate('Y-m-d H:i:s', time() + $offset); }
function body(): array {
    $raw = file_get_contents('php://input', false, null, 0, 4_000_000);
    $GLOBALS['RAW_BODY'] = is_string($raw) ? $raw : '';
    if ($raw === '' || $raw === false) return [];
    $d = json_decode($raw, true);
    if (!is_array($d)) fail(400, 'Invalid JSON');
    return $d;
}
function me(): ?array {
    if (empty($_SESSION['uid'])) return null;
    $st = db()->prepare('SELECT id, email, name FROM users WHERE id = ?');
    $st->execute([$_SESSION['uid']]);
    $u = $st->fetch();
    return $u ? ['id' => (int)$u['id'], 'email' => $u['email'], 'name' => $u['name']] : null;
}
function needUser(): array {
    $u = me();
    if (!$u) fail(401, 'Please log in', ['loggedOut' => true]);
    return $u;
}
function logIn(int $uid): void {
    session_regenerate_id(true);
    $_SESSION['uid'] = $uid;
    $_SESSION['renewed'] = time();
}
function ip(): string { return substr($_SERVER['REMOTE_ADDR'] ?? 'unknown', 0, 45); }
function tooMany(string $kind, int $max): bool {
    $st = db()->prepare('SELECT COUNT(*) FROM login_attempts WHERE ip = ? AND kind = ? AND attempted_at > ?');
    $st->execute([ip(), $kind, now(-15 * 60)]);
    return (int)$st->fetchColumn() >= $max;
}
function record(string $kind): void {
    db()->prepare('INSERT INTO login_attempts (ip, kind, attempted_at) VALUES (?, ?, ?)')->execute([ip(), $kind, now()]);
    if (random_int(1, 50) === 1) db()->prepare('DELETE FROM login_attempts WHERE attempted_at < ?')->execute([now(-86400)]);
}
function charSummary(array $build): array {
    return [
        'name' => mb_substr((string)($build['name'] ?? 'Unnamed'), 0, 120) ?: 'Unnamed',
        'level' => max(1, min(20, (int)($build['level'] ?? 1))),
        'class' => mb_substr((string)($build['class'] ?? ''), 0, 60),
        'ancestry' => mb_substr((string)($build['ancestry'] ?? ''), 0, 80),
        'heritage' => mb_substr((string)($build['heritage'] ?? ''), 0, 80),
    ];
}
function ownChar(int $id, int $uid): array {
    $st = db()->prepare('SELECT * FROM characters WHERE id = ? AND user_id = ?');
    $st->execute([$id, $uid]);
    $c = $st->fetch();
    if (!$c) fail(404, 'Character not found');
    return $c;
}
function iso(string $dt): string { return str_replace(' ', 'T', $dt) . 'Z'; }
/** A field of the request body as JSON, exactly as sent: an empty {} stays {} (decoding to PHP arrays turns it into []). */
function exactJson(string $key, $default = null): string {
    $o = json_decode($GLOBALS['RAW_BODY'] ?? '', false);
    $v = is_object($o) && property_exists($o, $key) ? $o->$key : $default;
    return json_encode($v ?? $default, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}
/** Stored JSON back out, keeping {} as {}. */
function jsonOut(?string $s, bool $objectIfEmpty = false) {
    $v = json_decode((string)$s, false);
    if ($objectIfEmpty && (!$v || $v === [])) return new stdClass();
    return $v;
}
function charOut(array $c): array {
    return ['id' => (string)$c['id'], 'name' => $c['name'], 'build' => jsonOut($c['build']), 'state' => jsonOut($c['state'], true),
        'share_token' => $c['share_token'], 'version' => (int)$c['version'], 'updated' => iso($c['updated_at'])];
}
// ------------------------------------------------------------------ parties
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I to mix up
function newCode(): string {
    for ($t = 0; $t < 20; $t++) {
        $c = '';
        for ($i = 0; $i < 6; $i++) $c .= CODE_CHARS[random_int(0, strlen(CODE_CHARS) - 1)];
        $st = db()->prepare('SELECT 1 FROM parties WHERE code = ?');
        $st->execute([$c]);
        if (!$st->fetchColumn()) return $c;
    }
    fail(500, 'Could not make a party code');
}
function cleanCode(string $c): string { return preg_replace('/[^A-Z0-9]/', '', strtoupper($c)); }
function ownParty(int $id, int $uid): array {
    $st = db()->prepare('SELECT * FROM parties WHERE id = ? AND owner_id = ?');
    $st->execute([$id, $uid]);
    $p = $st->fetch();
    if (!$p) fail(404, 'Party not found');
    return $p;
}
function ownEncounter(string $id, int $uid): ?array {
    $st = db()->prepare('SELECT * FROM encounters WHERE user_id = ? AND id = ?');
    $st->execute([$uid, $id]);
    return $st->fetch() ?: null;
}
function encOut(array $e): array {
    return ['id' => $e['id'], 'name' => $e['name'], 'summary' => $e['summary'], 'version' => (int)$e['version'], 'updated' => iso($e['updated_at']), 'data' => jsonOut($e['data'])];
}
function partyOut(array $p): array {
    $st = db()->prepare('SELECT COUNT(*) FROM party_members WHERE party_id = ?');
    $st->execute([$p['id']]);
    return ['id' => (string)$p['id'], 'name' => $p['name'], 'code' => $p['code'], 'locked' => (bool)$p['locked'], 'members' => (int)$st->fetchColumn()];
}

function siteUrl(): string {
    global $config, $https;
    if (!empty($config['site_url'])) return rtrim((string)$config['site_url'], '/');
    $dir = rtrim(dirname(dirname($_SERVER['SCRIPT_NAME'] ?? '/api/index.php')), '/');
    return ($https ? 'https' : 'http') . '://' . ($_SERVER['HTTP_HOST'] ?? 'localhost') . $dir;
}
function mailFrom(): string {
    global $config;
    return (string)($config['mail_from'] ?? $config['smtp_user'] ?? ('noreply@' . preg_replace('/^www\./', '', $_SERVER['HTTP_HOST'] ?? 'localhost')));
}
function canMail(): bool { global $config; return !empty($config['smtp_host']) || !empty($config['mail_log']) || !empty($config['use_php_mail']); }

/** Sends a plain-text email via SMTP (config smtp_*), a log file (local testing) or PHP mail(). */
function sendMail(string $to, string $subject, string $text): bool {
    global $config;
    $from = mailFrom();
    $fromName = (string)($config['mail_from_name'] ?? 'PF2e Characters');
    if (!empty($config['mail_log'])) {
        return (bool)file_put_contents($config['mail_log'], "To: $to\nSubject: $subject\n\n$text\n----\n", FILE_APPEND);
    }
    $headers = [
        'From' => "$fromName <$from>", 'Reply-To' => $from, 'MIME-Version' => '1.0',
        'Content-Type' => 'text/plain; charset=UTF-8', 'Content-Transfer-Encoding' => '8bit',
        'Date' => date('r'), 'Message-ID' => '<' . bin2hex(random_bytes(12)) . '@' . substr(strrchr($from, '@'), 1) . '>',
    ];
    $subjectEnc = '=?UTF-8?B?' . base64_encode($subject) . '?=';
    if (empty($config['smtp_host'])) {
        $h = '';
        foreach ($headers as $k => $v) $h .= "$k: $v\r\n";
        return mail($to, $subjectEnc, $text, $h, '-f' . $from);
    }
    $port = (int)($config['smtp_port'] ?? 465);
    $secure = $config['smtp_secure'] ?? ($port === 465 ? 'ssl' : 'tls');
    $ctx = stream_context_create(['ssl' => ['verify_peer' => true, 'verify_peer_name' => true]]);
    $fp = @stream_socket_client(($secure === 'ssl' ? 'ssl://' : 'tcp://') . $config['smtp_host'] . ':' . $port, $errno, $errstr, 15, STREAM_CLIENT_CONNECT, $ctx);
    if (!$fp) { error_log("PF2e mail: cannot connect ($errstr)"); return false; }
    stream_set_timeout($fp, 20);
    $read = function () use ($fp): string {
        $out = '';
        while (($line = fgets($fp, 1024)) !== false) { $out .= $line; if (strlen($line) < 4 || $line[3] === ' ') break; }
        return $out;
    };
    $cmd = function (?string $c, array $codes) use ($fp, $read): string {
        if ($c !== null) fwrite($fp, $c . "\r\n");
        $r = $read();
        if (!in_array((int)substr($r, 0, 3), $codes, true)) throw new RuntimeException(trim(($c && str_starts_with($c, 'AUTH') ? 'AUTH' : (string)$c) . ' -> ' . $r));
        return $r;
    };
    try {
        $helo = 'EHLO ' . preg_replace('/[^a-z0-9.-]/i', '', $_SERVER['HTTP_HOST'] ?? 'localhost');
        $cmd(null, [220]);
        $cmd($helo, [250]);
        if ($secure === 'tls') { // 'none' only for local testing
            $cmd('STARTTLS', [220]);
            if (!stream_socket_enable_crypto($fp, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) throw new RuntimeException('STARTTLS failed');
            $cmd($helo, [250]);
        }
        $cmd('AUTH LOGIN', [334]);
        $cmd(base64_encode((string)$config['smtp_user']), [334]);
        $cmd(base64_encode((string)$config['smtp_pass']), [235]);
        $cmd("MAIL FROM:<$from>", [250]);
        $cmd("RCPT TO:<$to>", [250, 251]);
        $cmd('DATA', [354]);
        $msg = "To: <$to>\r\nSubject: $subjectEnc\r\n";
        foreach ($headers as $k => $v) $msg .= "$k: $v\r\n";
        $msg .= "\r\n" . preg_replace('/^\./m', '..', str_replace("\n", "\r\n", str_replace("\r\n", "\n", $text)));
        $cmd($msg . "\r\n.", [250]);
        $cmd('QUIT', [221]);
        fclose($fp);
        return true;
    } catch (Throwable $e) {
        error_log('PF2e mail: ' . $e->getMessage());
        @fclose($fp);
        return false;
    }
}

$route = $_GET['r'] ?? '';
$method = $_SERVER['REQUEST_METHOD'];
if ($method === 'POST') {
    if (($_SERVER['HTTP_X_PF2E'] ?? '') !== '1') fail(403, 'Missing request header');
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origin && parse_url($origin, PHP_URL_HOST) !== parse_url('//' . ($_SERVER['HTTP_HOST'] ?? ''), PHP_URL_HOST)) fail(403, 'Cross-site request blocked');
}

switch ("$method $route") {
    case 'GET status':
        db();
        ok(['configured' => true, 'register' => !empty($config['allow_register']), 'invite' => !empty($config['invite_code']), 'mail' => canMail()]);

    case 'GET me':
        ok(['user' => me()]);

    case 'POST register':
        if (empty($config['allow_register'])) fail(403, 'Sign-ups are closed. Ask your GM for an account.');
        if (tooMany('register', 10)) fail(429, 'Too many sign-ups from here. Try again in 15 minutes.');
        $b = body();
        if (!empty($config['invite_code']) && !hash_equals((string)$config['invite_code'], trim((string)($b['invite'] ?? '')))) { record('register'); fail(403, 'Wrong or missing invite code'); }
        $email = strtolower(trim((string)($b['email'] ?? '')));
        $pass = (string)($b['password'] ?? '');
        $name = mb_substr(trim((string)($b['name'] ?? '')), 0, 100);
        if (!filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($email) > 190) fail(400, 'Enter a valid email address');
        if (strlen($pass) < 8) fail(400, 'Password must be at least 8 characters');
        if (strlen($pass) > 200) fail(400, 'Password is too long');
        $st = db()->prepare('SELECT 1 FROM users WHERE email = ?');
        $st->execute([$email]);
        if ($st->fetch()) fail(409, 'An account with this email already exists. Log in, or use "Forgot password".');
        record('register');
        db()->prepare('INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)')
            ->execute([$email, $name ?: explode('@', $email)[0], password_hash($pass, PASSWORD_DEFAULT), now()]);
        logIn((int)db()->lastInsertId());
        ok(['user' => me()]);

    case 'POST login':
        if (tooMany('login', 10)) fail(429, 'Too many attempts. Try again in 15 minutes.');
        $b = body();
        $st = db()->prepare('SELECT id, password_hash FROM users WHERE email = ?');
        $st->execute([strtolower(trim((string)($b['email'] ?? '')))]);
        $u = $st->fetch();
        if (!$u || !password_verify((string)($b['password'] ?? ''), $u['password_hash'])) { record('login'); usleep(400000); fail(401, 'Wrong email or password'); }
        if (password_needs_rehash($u['password_hash'], PASSWORD_DEFAULT)) db()->prepare('UPDATE users SET password_hash = ? WHERE id = ?')->execute([password_hash((string)$b['password'], PASSWORD_DEFAULT), $u['id']]);
        logIn((int)$u['id']);
        ok(['user' => me()]);

    case 'POST logout':
        $_SESSION = [];
        session_destroy();
        setcookie(session_name(), '', ['expires' => time() - 3600, 'path' => '/', 'secure' => $https, 'httponly' => true, 'samesite' => 'Lax']);
        ok(['ok' => true]);

    case 'POST forgot':
        if (!canMail()) fail(400, 'This site can\'t send email yet. Ask your GM to reset your password.');
        if (tooMany('forgot', 5)) fail(429, 'Too many requests. Try again in 15 minutes.');
        record('forgot');
        $email = strtolower(trim((string)(body()['email'] ?? '')));
        $st = db()->prepare('SELECT id, name FROM users WHERE email = ?');
        $st->execute([$email]);
        if ($u = $st->fetch()) {
            $token = bin2hex(random_bytes(32));
            db()->prepare('DELETE FROM password_resets WHERE user_id = ? OR expires_at < ?')->execute([$u['id'], now()]);
            db()->prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)')->execute([hash('sha256', $token), $u['id'], now(3600)]);
            $link = siteUrl() . '/reset.html#token=' . $token;
            $sent = sendMail($email, 'Reset your PF2e Characters password',
                "Hi {$u['name']},\n\nSomeone (hopefully you) asked to reset the password for your PF2e Characters account.\n\nSet a new password here (the link works for one hour):\n$link\n\nIf you didn't ask for this, ignore this email — your password stays the same.\n");
            if (!$sent) fail(500, 'The email could not be sent. Try again later or ask your GM.');
        }
        ok(['ok' => true]);

    case 'POST reset':
        if (tooMany('reset', 20)) fail(429, 'Too many attempts. Try again in 15 minutes.');
        $b = body();
        $token = (string)($b['token'] ?? '');
        $pass = (string)($b['password'] ?? '');
        if (strlen($pass) < 8) fail(400, 'Password must be at least 8 characters');
        if (strlen($pass) > 200) fail(400, 'Password is too long');
        $st = db()->prepare('SELECT user_id FROM password_resets WHERE token_hash = ? AND expires_at > ?');
        $st->execute([hash('sha256', $token), now()]);
        $uid = $st->fetchColumn();
        if (!$uid) { record('reset'); fail(400, 'This reset link has expired or was already used. Ask for a new one.'); }
        db()->prepare('UPDATE users SET password_hash = ? WHERE id = ?')->execute([password_hash($pass, PASSWORD_DEFAULT), $uid]);
        db()->prepare('DELETE FROM password_resets WHERE user_id = ?')->execute([$uid]);
        logIn((int)$uid);
        ok(['user' => me()]);

    case 'POST account':
        $u = needUser();
        $b = body();
        if (isset($b['name'])) {
            $name = mb_substr(trim((string)$b['name']), 0, 100);
            if ($name === '') fail(400, 'Enter a name');
            db()->prepare('UPDATE users SET name = ? WHERE id = ?')->execute([$name, $u['id']]);
        }
        if (isset($b['password'])) {
            $st = db()->prepare('SELECT password_hash FROM users WHERE id = ?');
            $st->execute([$u['id']]);
            if (!password_verify((string)($b['current'] ?? ''), (string)$st->fetchColumn())) { record('login'); fail(401, 'Your current password is wrong'); }
            if (strlen((string)$b['password']) < 8) fail(400, 'New password must be at least 8 characters');
            db()->prepare('UPDATE users SET password_hash = ? WHERE id = ?')->execute([password_hash((string)$b['password'], PASSWORD_DEFAULT), $u['id']]);
            session_regenerate_id(true);
        }
        ok(['user' => me()]);

    case 'POST delete_account':
        $u = needUser();
        $st = db()->prepare('SELECT password_hash FROM users WHERE id = ?');
        $st->execute([$u['id']]);
        if (!password_verify((string)(body()['password'] ?? ''), (string)$st->fetchColumn())) { record('login'); fail(401, 'Wrong password'); }
        db()->prepare('DELETE FROM party_members WHERE character_id IN (SELECT id FROM characters WHERE user_id = ?)')->execute([$u['id']]);
        db()->prepare('DELETE FROM party_members WHERE party_id IN (SELECT id FROM parties WHERE owner_id = ?)')->execute([$u['id']]);
        db()->prepare('DELETE FROM parties WHERE owner_id = ?')->execute([$u['id']]);
        db()->prepare('DELETE FROM encounters WHERE user_id = ?')->execute([$u['id']]);
        db()->prepare('DELETE FROM homebrew WHERE user_id = ?')->execute([$u['id']]);
        db()->prepare('DELETE FROM characters WHERE user_id = ?')->execute([$u['id']]);
        db()->prepare('DELETE FROM password_resets WHERE user_id = ?')->execute([$u['id']]);
        db()->prepare('DELETE FROM users WHERE id = ?')->execute([$u['id']]);
        $_SESSION = [];
        session_destroy();
        ok(['ok' => true]);

    case 'GET characters':
        $u = needUser();
        $st = db()->prepare('SELECT id, name, level, class, ancestry, heritage, version, updated_at FROM characters WHERE user_id = ? ORDER BY updated_at DESC');
        $st->execute([$u['id']]);
        ok(['characters' => array_map(fn($c) => ['id' => (string)$c['id'], 'name' => $c['name'], 'level' => (int)$c['level'], 'class' => $c['class'], 'ancestry' => $c['ancestry'], 'heritage' => $c['heritage'], 'version' => (int)$c['version'], 'updated' => iso($c['updated_at'])], $st->fetchAll())]);

    case 'GET character':
        $u = needUser();
        ok(['character' => charOut(ownChar((int)($_GET['id'] ?? 0), $u['id']))]);

    case 'POST character':
        $u = needUser();
        $b = body();
        if (!isset($b['build']) || !is_array($b['build'])) fail(400, 'Missing build');
        $sum = charSummary($b['build']);
        $build = exactJson('build');
        $state = exactJson('state', new stdClass());
        $id = (int)($b['id'] ?? 0);
        if ($id) {
            $c = ownChar($id, $u['id']);
            // Another device saved since this one loaded the character: ask before overwriting.
            if (isset($b['version']) && empty($b['force']) && (int)$b['version'] !== (int)$c['version']) {
                fail(409, 'This character was changed on another device', ['conflict' => true, 'version' => (int)$c['version'], 'updated' => iso($c['updated_at'])]);
            }
            $ver = (int)$c['version'] + 1;
            // The live sheet state (HP, conditions…) has its own route; only replace it here when it was sent.
            if (array_key_exists('state', $b)) {
                db()->prepare('UPDATE characters SET name=?, level=?, class=?, ancestry=?, heritage=?, build=?, state=?, version=?, updated_at=? WHERE id=? AND user_id=?')
                    ->execute([$sum['name'], $sum['level'], $sum['class'], $sum['ancestry'], $sum['heritage'], $build, $state, $ver, now(), $id, $u['id']]);
            } else {
                db()->prepare('UPDATE characters SET name=?, level=?, class=?, ancestry=?, heritage=?, build=?, version=?, updated_at=? WHERE id=? AND user_id=?')
                    ->execute([$sum['name'], $sum['level'], $sum['class'], $sum['ancestry'], $sum['heritage'], $build, $ver, now(), $id, $u['id']]);
            }
        } else {
            $st = db()->prepare('SELECT COUNT(*) FROM characters WHERE user_id = ?');
            $st->execute([$u['id']]);
            if ((int)$st->fetchColumn() >= 200) fail(400, 'Character limit reached');
            $ver = 1;
            db()->prepare('INSERT INTO characters (user_id, name, level, class, ancestry, heritage, build, state, version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
                ->execute([$u['id'], $sum['name'], $sum['level'], $sum['class'], $sum['ancestry'], $sum['heritage'], $build, $state, $ver, now(), now()]);
            $id = (int)db()->lastInsertId();
        }
        ok(['id' => (string)$id, 'version' => $ver, 'updated' => iso(now())]);

    case 'POST character_state':
        $u = needUser();
        $b = body();
        $id = (int)($b['id'] ?? 0);
        ownChar($id, $u['id']);
        db()->prepare('UPDATE characters SET state=?, updated_at=? WHERE id=? AND user_id=?')
            ->execute([exactJson('state', new stdClass()), now(), $id, $u['id']]);
        ok(['ok' => true]);

    case 'POST delete':
        $u = needUser();
        $b = body();
        db()->prepare('DELETE FROM party_members WHERE character_id IN (SELECT id FROM characters WHERE id=? AND user_id=?)')->execute([(int)($b['id'] ?? 0), $u['id']]);
        db()->prepare('DELETE FROM characters WHERE id=? AND user_id=?')->execute([(int)($b['id'] ?? 0), $u['id']]);
        ok(['ok' => true]);

    case 'POST share':
        $u = needUser();
        $b = body();
        $c = ownChar((int)($b['id'] ?? 0), $u['id']);
        $token = !empty($b['on']) ? ($c['share_token'] ?: bin2hex(random_bytes(16))) : null;
        db()->prepare('UPDATE characters SET share_token=? WHERE id=?')->execute([$token, $c['id']]);
        ok(['share_token' => $token]);

    case 'GET shared':
        $t = (string)($_GET['token'] ?? '');
        if (!preg_match('/^[a-f0-9]{32}$/', $t)) fail(404, 'Link not valid');
        $st = db()->prepare('SELECT * FROM characters WHERE share_token = ?');
        $st->execute([$t]);
        $c = $st->fetch();
        if (!$c) fail(404, 'This sheet is no longer shared');
        $out = charOut($c);
        unset($out['share_token']);
        ok(['character' => $out]);

    // ---------------------------------------------------------------- parties (GM side)
    case 'GET parties':
        $u = needUser();
        $st = db()->prepare('SELECT * FROM parties WHERE owner_id = ? ORDER BY updated_at DESC');
        $st->execute([$u['id']]);
        ok(['parties' => array_map('partyOut', $st->fetchAll())]);

    case 'POST party_create':
        $u = needUser();
        $st = db()->prepare('SELECT COUNT(*) FROM parties WHERE owner_id = ?');
        $st->execute([$u['id']]);
        if ((int)$st->fetchColumn() >= 20) fail(400, 'You can run up to 20 parties');
        $name = mb_substr(trim((string)(body()['name'] ?? '')), 0, 100) ?: 'My party';
        db()->prepare('INSERT INTO parties (owner_id, name, code, locked, created_at, updated_at) VALUES (?,?,?,0,?,?)')->execute([$u['id'], $name, newCode(), now(), now()]);
        ok(['party' => partyOut(ownParty((int)db()->lastInsertId(), $u['id']))]);

    case 'POST party_update':
        $u = needUser();
        $b = body();
        $p = ownParty((int)($b['id'] ?? 0), $u['id']);
        $name = isset($b['name']) ? (mb_substr(trim((string)$b['name']), 0, 100) ?: $p['name']) : $p['name'];
        $locked = isset($b['locked']) ? (int)(bool)$b['locked'] : (int)$p['locked'];
        $code = !empty($b['newCode']) ? newCode() : $p['code'];
        db()->prepare('UPDATE parties SET name=?, locked=?, code=?, updated_at=? WHERE id=?')->execute([$name, $locked, $code, now(), $p['id']]);
        ok(['party' => partyOut(ownParty((int)$p['id'], $u['id']))]);

    case 'POST party_delete':
        $u = needUser();
        $p = ownParty((int)(body()['id'] ?? 0), $u['id']);
        db()->prepare('DELETE FROM party_members WHERE party_id = ?')->execute([$p['id']]);
        db()->prepare('DELETE FROM parties WHERE id = ?')->execute([$p['id']]);
        ok(['ok' => true]);

    case 'GET party':
        // The GM's live view: every member's build and sheet state. With since=…, only sheets changed since then.
        $u = needUser();
        $p = ownParty((int)($_GET['id'] ?? 0), $u['id']);
        $since = (string)($_GET['since'] ?? '');
        $q = 'SELECT c.*, u.name AS player FROM party_members m JOIN characters c ON c.id = m.character_id JOIN users u ON u.id = c.user_id WHERE m.party_id = ?';
        $args = [$p['id']];
        $ids = db()->prepare('SELECT character_id FROM party_members WHERE party_id = ? ORDER BY joined_at');
        $ids->execute([$p['id']]);
        if (preg_match('/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/', $since)) { $t = str_replace(['T', 'Z'], [' ', ''], $since); $q .= ' AND (c.updated_at >= ? OR m.joined_at >= ?)'; $args[] = $t; $args[] = $t; }
        $st = db()->prepare($q . ' ORDER BY m.joined_at');
        $st->execute($args);
        $members = array_map(function ($c) { $o = charOut($c); unset($o['share_token']); $o['player'] = $c['player']; return $o; }, $st->fetchAll());
        ok(['party' => partyOut($p), 'ids' => array_map(fn($x) => (string)$x, $ids->fetchAll(PDO::FETCH_COLUMN)), 'members' => $members, 'now' => iso(now())]);

    case 'POST party_remove':
        $u = needUser();
        $b = body();
        $p = ownParty((int)($b['id'] ?? 0), $u['id']);
        db()->prepare('DELETE FROM party_members WHERE party_id = ? AND character_id = ?')->execute([$p['id'], (int)($b['character_id'] ?? 0)]);
        ok(['ok' => true]);

    // ---------------------------------------------------------------- parties (player side)
    case 'POST party_join':
        $u = needUser();
        if (tooMany('join', 30)) fail(429, 'Too many tries. Wait a few minutes.');
        $b = body();
        $c = ownChar((int)($b['character_id'] ?? 0), $u['id']);
        $st = db()->prepare('SELECT * FROM parties WHERE code = ?');
        $st->execute([cleanCode((string)($b['code'] ?? ''))]);
        $p = $st->fetch();
        if (!$p) { record('join'); fail(404, 'No party has that code. Check it with your GM.'); }
        if ($p['locked']) fail(403, 'This party is locked. Ask your GM to unlock it.');
        $st = db()->prepare('SELECT 1 FROM party_members WHERE party_id = ? AND character_id = ?');
        $st->execute([$p['id'], $c['id']]);
        if (!$st->fetchColumn()) db()->prepare('INSERT INTO party_members (party_id, character_id, joined_at) VALUES (?,?,?)')->execute([$p['id'], $c['id'], now()]);
        db()->prepare('UPDATE parties SET updated_at=? WHERE id=?')->execute([now(), $p['id']]);
        ok(['party' => ['id' => (string)$p['id'], 'name' => $p['name']]]);

    case 'POST party_leave':
        $u = needUser();
        $b = body();
        $c = ownChar((int)($b['character_id'] ?? 0), $u['id']);
        db()->prepare('DELETE FROM party_members WHERE party_id = ? AND character_id = ?')->execute([(int)($b['party_id'] ?? 0), $c['id']]);
        ok(['ok' => true]);

    case 'GET party_peek':
        // What a join code leads to, so the player sees the party's name before joining.
        $u = needUser();
        if (tooMany('join', 30)) fail(429, 'Too many tries. Wait a few minutes.');
        $st = db()->prepare('SELECT p.name, p.locked, u.name AS gm FROM parties p JOIN users u ON u.id = p.owner_id WHERE p.code = ?');
        $st->execute([cleanCode((string)($_GET['code'] ?? ''))]);
        $p = $st->fetch();
        if (!$p) { record('join'); fail(404, 'No party has that code. Check it with your GM.'); }
        ok(['party' => ['name' => $p['name'], 'gm' => $p['gm'], 'locked' => (bool)$p['locked']]]);

    case 'GET character_parties':
        $u = needUser();
        $c = ownChar((int)($_GET['id'] ?? 0), $u['id']);
        $st = db()->prepare('SELECT p.id, p.name, u.name AS gm FROM party_members m JOIN parties p ON p.id = m.party_id JOIN users u ON u.id = p.owner_id WHERE m.character_id = ? ORDER BY m.joined_at');
        $st->execute([$c['id']]);
        ok(['parties' => array_map(fn($p) => ['id' => (string)$p['id'], 'name' => $p['name'], 'gm' => $p['gm']], $st->fetchAll())]);

    // ---------------------------------------------------------------- saved encounters (GM screen)
    // The browser makes the id, so an encounter made offline keeps it when it syncs.
    case 'GET encounters':
        $u = needUser();
        $st = db()->prepare('SELECT id, name, summary, version, updated_at FROM encounters WHERE user_id = ? ORDER BY updated_at DESC');
        $st->execute([$u['id']]);
        ok(['encounters' => array_map(fn($e) => ['id' => $e['id'], 'name' => $e['name'], 'summary' => $e['summary'], 'version' => (int)$e['version'], 'updated' => iso($e['updated_at'])], $st->fetchAll())]);

    case 'GET encounter':
        $u = needUser();
        $e = ownEncounter((string)($_GET['id'] ?? ''), $u['id']);
        if (!$e) fail(404, 'Encounter not found');
        ok(['encounter' => encOut($e)]);

    case 'POST encounter_save':
        $u = needUser();
        $b = body();
        $id = (string)($b['id'] ?? '');
        if (!preg_match('/^[A-Za-z0-9_-]{6,40}$/', $id)) fail(400, 'Bad encounter id');
        $data = exactJson('data');
        if (!is_array($b['data'] ?? null) || strlen($data) > 400000) fail(400, 'Encounter is missing or too big');
        $name = mb_substr(trim((string)($b['name'] ?? '')), 0, 120) ?: 'Encounter';
        $summary = mb_substr(trim((string)($b['summary'] ?? '')), 0, 255);
        $old = ownEncounter($id, $u['id']);
        if ($old) {
            db()->prepare('UPDATE encounters SET name=?, summary=?, data=?, version=version+1, updated_at=? WHERE user_id=? AND id=?')->execute([$name, $summary, $data, now(), $u['id'], $id]);
        } else {
            $st = db()->prepare('SELECT COUNT(*) FROM encounters WHERE user_id = ?');
            $st->execute([$u['id']]);
            if ((int)$st->fetchColumn() >= 500) fail(400, 'You can keep up to 500 encounters; delete a few old ones');
            db()->prepare('INSERT INTO encounters (user_id, id, name, summary, data, version, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?)')->execute([$u['id'], $id, $name, $summary, $data, now(), now()]);
        }
        $e = ownEncounter($id, $u['id']);
        ok(['id' => $id, 'version' => (int)$e['version'], 'updated' => iso($e['updated_at'])]);

    case 'POST encounter_delete':
        $u = needUser();
        db()->prepare('DELETE FROM encounters WHERE user_id = ? AND id = ?')->execute([$u['id'], (string)(body()['id'] ?? '')]);
        ok(['ok' => true]);

    // ---------------------------------------------------------------- homebrew (the GM's own creatures)
    case 'GET homebrew':
        $u = needUser();
        $st = db()->prepare('SELECT id, kind, name, data, version, updated_at FROM homebrew WHERE user_id = ? ORDER BY name');
        $st->execute([$u['id']]);
        ok(['items' => array_map(fn($h) => ['id' => $h['id'], 'kind' => $h['kind'], 'name' => $h['name'], 'version' => (int)$h['version'], 'updated' => iso($h['updated_at']), 'data' => jsonOut($h['data'])], $st->fetchAll())]);

    case 'POST homebrew_save':
        $u = needUser();
        $b = body();
        $id = (string)($b['id'] ?? '');
        if (!preg_match('/^[A-Za-z0-9_-]{6,40}$/', $id)) fail(400, 'Bad id');
        $kind = in_array($b['kind'] ?? '', ['creature'], true) ? $b['kind'] : 'creature';
        $data = exactJson('data');
        if (!is_array($b['data'] ?? null) || strlen($data) > 200000) fail(400, 'Missing or too big');
        $name = mb_substr(trim((string)($b['name'] ?? '')), 0, 120) ?: 'Unnamed';
        $st = db()->prepare('SELECT version FROM homebrew WHERE user_id = ? AND id = ?');
        $st->execute([$u['id'], $id]);
        if ($st->fetchColumn() !== false) {
            db()->prepare('UPDATE homebrew SET kind=?, name=?, data=?, version=version+1, updated_at=? WHERE user_id=? AND id=?')->execute([$kind, $name, $data, now(), $u['id'], $id]);
        } else {
            $st = db()->prepare('SELECT COUNT(*) FROM homebrew WHERE user_id = ?');
            $st->execute([$u['id']]);
            if ((int)$st->fetchColumn() >= 1000) fail(400, 'You can keep up to 1000 homebrew creatures');
            db()->prepare('INSERT INTO homebrew (user_id, id, kind, name, data, version, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?)')->execute([$u['id'], $id, $kind, $name, $data, now(), now()]);
        }
        $st = db()->prepare('SELECT version, updated_at FROM homebrew WHERE user_id = ? AND id = ?');
        $st->execute([$u['id'], $id]);
        $h = $st->fetch();
        ok(['id' => $id, 'version' => (int)$h['version'], 'updated' => iso($h['updated_at'])]);

    case 'POST homebrew_delete':
        $u = needUser();
        db()->prepare('DELETE FROM homebrew WHERE user_id = ? AND id = ?')->execute([$u['id'], (string)(body()['id'] ?? '')]);
        ok(['ok' => true]);

    default:
        fail(404, 'Unknown route');
}
