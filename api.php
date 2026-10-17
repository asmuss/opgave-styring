<?php
// Opgavestyring - API til hjemmesiden (PHP 8.1+, SQLite eller MySQL)
declare(strict_types=1);

const CONFIG_FILE = __DIR__ . '/config.php';
const DATA_DIR = __DIR__ . '/data';
const SESSION_DAYS = 30;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_IMAGES = 10;

const PROPERTY_TYPES = ['hus', 'lejlighed', 'sommerhus', 'andet'];
const ROOM_TYPES = ['stue', 'vaerelse', 'koekken', 'badevaerelse', 'gang', 'udenfor', 'andet'];
const STATUSES = ['mangler', 'igang', 'faerdig'];
const PRIORITIES = ['lav', 'normal', 'hoej'];
const DEFAULT_ROOMS = [
    ['Stue', 'stue'],
    ['Køkken', 'koekken'],
    ['Gang', 'gang'],
    ['Badeværelse', 'badevaerelse'],
    ['Værelse 1', 'vaerelse'],
];
const IMAGE_TYPES = [
    'image/jpeg' => 'jpg',
    'image/png' => 'png',
    'image/webp' => 'webp',
    'image/gif' => 'gif',
    'image/heic' => 'heic',
    'image/heif' => 'heif',
];

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: same-origin');
header('Cache-Control: no-store');

final class HttpError extends Exception
{
    public function __construct(public int $status, string $message)
    {
        parent::__construct($message);
    }
}

function respond(mixed $data, int $status = 200): never
{
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

set_exception_handler(function (Throwable $e): void {
    if ($e instanceof HttpError) respond(['error' => $e->getMessage()], $e->status);
    error_log((string) $e);
    respond(['error' => 'Der skete en fejl på serveren'], 500);
});

// ---------- Konfiguration og database ----------

function config(): ?array
{
    static $config = false;
    if ($config === false) $config = is_file(CONFIG_FILE) ? require CONFIG_FILE : null;
    return $config;
}

function connect(array $c): PDO
{
    $opts = [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ];
    if ($c['driver'] === 'mysql') {
        $dsn = "mysql:host={$c['mysql_host']};dbname={$c['mysql_name']};charset=utf8mb4";
        return new PDO($dsn, $c['mysql_user'], $c['mysql_pass'], $opts);
    }
    $pdo = new PDO('sqlite:' . $c['sqlite_path'], null, null, $opts);
    $pdo->exec('PRAGMA foreign_keys = ON');
    $pdo->exec('PRAGMA busy_timeout = 5000');
    return $pdo;
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo === null) {
        $c = config();
        if (!$c) throw new HttpError(503, 'Siden er ikke installeret endnu');
        $pdo = connect($c);
    }
    return $pdo;
}

function q(string $sql, array $params = []): PDOStatement
{
    $stmt = db()->prepare($sql);
    $stmt->execute($params);
    return $stmt;
}

function createSchema(PDO $pdo, string $driver): void
{
    if ($driver === 'mysql') {
        $pk = 'INT AUTO_INCREMENT PRIMARY KEY';
        $suffix = ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
        $str = fn(int $n) => "VARCHAR($n)";
        $int = 'INT';
    } else {
        $pk = 'INTEGER PRIMARY KEY';
        $suffix = '';
        $str = fn(int $n) => 'TEXT';
        $int = 'INTEGER';
    }
    $nocase = $driver === 'mysql' ? '' : ' COLLATE NOCASE';
    $statements = [
        "CREATE TABLE IF NOT EXISTS users (
            id $pk,
            username {$str(40)} NOT NULL UNIQUE$nocase,
            password_hash {$str(255)} NOT NULL,
            created_at {$str(19)} NOT NULL)$suffix",
        "CREATE TABLE IF NOT EXISTS sessions (
            token {$str(64)} NOT NULL PRIMARY KEY,
            user_id $int NOT NULL,
            expires_at BIGINT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)$suffix",
        "CREATE TABLE IF NOT EXISTS login_failures (
            ip {$str(45)} NOT NULL PRIMARY KEY,
            attempts $int NOT NULL,
            reset_at BIGINT NOT NULL)$suffix",
        "CREATE TABLE IF NOT EXISTS properties (
            id $pk,
            name {$str(80)} NOT NULL,
            type {$str(20)} NOT NULL,
            address {$str(200)} NOT NULL,
            created_at {$str(19)} NOT NULL)$suffix",
        "CREATE TABLE IF NOT EXISTS rooms (
            id $pk,
            property_id $int NOT NULL,
            name {$str(60)} NOT NULL,
            type {$str(20)} NOT NULL,
            FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE)$suffix",
        "CREATE TABLE IF NOT EXISTS tasks (
            id $pk,
            property_id $int NOT NULL,
            room_id $int NULL,
            title {$str(150)} NOT NULL,
            description TEXT NOT NULL,
            status {$str(10)} NOT NULL,
            priority {$str(10)} NOT NULL,
            created_by $int NULL,
            created_at {$str(19)} NOT NULL,
            updated_at {$str(19)} NOT NULL,
            FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE,
            FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE SET NULL,
            FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL)$suffix",
        "CREATE TABLE IF NOT EXISTS images (
            id $pk,
            task_id $int NOT NULL,
            filename {$str(64)} NOT NULL,
            created_at {$str(19)} NOT NULL,
            FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE)$suffix",
    ];
    foreach ($statements as $sql) $pdo->exec($sql);
}

function uploadDir(): string
{
    return DATA_DIR . '/uploads';
}

// ---------- Hjælpefunktioner ----------

function now(): string
{
    return gmdate('Y-m-d H:i:s');
}

function lastId(): int
{
    return (int) db()->lastInsertId();
}

function text(mixed $value, int $max, string $field, bool $required = false): string
{
    $v = is_string($value) ? trim($value) : '';
    if ($required && $v === '') throw new HttpError(400, "$field skal udfyldes");
    if (mb_strlen($v) > $max) throw new HttpError(400, "$field må højst være $max tegn");
    return $v;
}

function oneOf(mixed $value, array $allowed, string $field): string
{
    if (!in_array($value, $allowed, true)) throw new HttpError(400, "Ugyldig værdi for $field");
    return $value;
}

function toId(mixed $value): ?int
{
    if (is_int($value)) return $value > 0 ? $value : null;
    if (is_string($value) && ctype_digit($value) && (int) $value > 0) return (int) $value;
    return null;
}

function ints(array $row, array $keys): array
{
    foreach ($keys as $k) if ($row[$k] !== null) $row[$k] = (int) $row[$k];
    return $row;
}

function validateCredentials(array $body): array
{
    $username = text($body['username'] ?? '', 40, 'Brugernavn', true);
    if (mb_strlen($username) < 3) throw new HttpError(400, 'Brugernavn skal være mindst 3 tegn');
    $password = is_string($body['password'] ?? null) ? $body['password'] : '';
    if (strlen($password) < 6) throw new HttpError(400, 'Adgangskode skal være mindst 6 tegn');
    if (strlen($password) > 200) throw new HttpError(400, 'Adgangskode er for lang');
    return [$username, $password];
}

function findUserByName(string $username): ?array
{
    // LOWER() så brugernavne er ens uanset store/små bogstaver i både SQLite og MySQL
    return q('SELECT * FROM users WHERE LOWER(username) = LOWER(?)', [$username])->fetch() ?: null;
}

function isHttps(): bool
{
    return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';
}

function setSessionCookie(string $value, int $expires): void
{
    setcookie('sid', $value, [
        'expires' => $expires,
        'path' => '/',
        'secure' => isHttps(),
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

function createSession(int $userId): void
{
    $token = bin2hex(random_bytes(32));
    $expires = time() + SESSION_DAYS * 86400;
    q('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', [$token, $userId, $expires]);
    setSessionCookie($token, $expires);
}

function currentUser(): ?array
{
    $token = $_COOKIE['sid'] ?? '';
    if (!is_string($token) || !preg_match('/^[a-f0-9]{64}$/', $token)) return null;
    $row = q('SELECT u.id, u.username, s.expires_at FROM sessions s
              JOIN users u ON u.id = s.user_id WHERE s.token = ?', [$token])->fetch();
    if (!$row) return null;
    if ((int) $row['expires_at'] < time()) {
        q('DELETE FROM sessions WHERE token = ?', [$token]);
        return null;
    }
    return ['id' => (int) $row['id'], 'username' => $row['username']];
}

function requireUser(): array
{
    $user = currentUser();
    if (!$user) throw new HttpError(401, 'Du skal logge ind');
    return $user;
}

function clientIp(): string
{
    return substr((string) ($_SERVER['REMOTE_ADDR'] ?? 'ukendt'), 0, 45);
}

function loginBlocked(string $ip): bool
{
    $row = q('SELECT attempts, reset_at FROM login_failures WHERE ip = ?', [$ip])->fetch();
    return $row && (int) $row['attempts'] >= 10 && (int) $row['reset_at'] > time();
}

function registerFailedLogin(string $ip): void
{
    $row = q('SELECT attempts, reset_at FROM login_failures WHERE ip = ?', [$ip])->fetch();
    if (!$row || (int) $row['reset_at'] < time()) {
        q('DELETE FROM login_failures WHERE ip = ?', [$ip]);
        q('INSERT INTO login_failures (ip, attempts, reset_at) VALUES (?, 1, ?)', [$ip, time() + 15 * 60]);
    } else {
        q('UPDATE login_failures SET attempts = attempts + 1 WHERE ip = ?', [$ip]);
    }
}

function removeFiles(array $filenames): void
{
    foreach ($filenames as $f) @unlink(uploadDir() . '/' . basename($f));
}

function getProperty(mixed $id): array
{
    $p = q('SELECT * FROM properties WHERE id = ?', [toId($id)])->fetch();
    if (!$p) throw new HttpError(404, 'Boligen findes ikke');
    return ints($p, ['id']);
}

function getTaskRow(mixed $id): array
{
    $t = q('SELECT * FROM tasks WHERE id = ?', [toId($id)])->fetch();
    if (!$t) throw new HttpError(404, 'Opgaven findes ikke');
    return ints($t, ['id', 'property_id', 'room_id']);
}

function checkRoom(mixed $roomId, int $propertyId): ?int
{
    if ($roomId === null || $roomId === '' || $roomId === 0) return null;
    $room = q('SELECT id FROM rooms WHERE id = ? AND property_id = ?', [toId($roomId), $propertyId])->fetch();
    if (!$room) throw new HttpError(400, 'Rummet hører ikke til den valgte bolig');
    return (int) $room['id'];
}

function loadTasks(string $where = '', array $params = []): array
{
    $rows = q("SELECT t.*, r.name AS room_name, r.type AS room_type,
                      p.name AS property_name, p.type AS property_type, u.username AS created_by_name
               FROM tasks t
               JOIN properties p ON p.id = t.property_id
               LEFT JOIN rooms r ON r.id = t.room_id
               LEFT JOIN users u ON u.id = t.created_by
               $where
               ORDER BY CASE t.status WHEN 'faerdig' THEN 1 ELSE 0 END,
                        CASE t.priority WHEN 'hoej' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
                        t.created_at DESC, t.id DESC", $params)->fetchAll();
    if (!$rows) return [];
    $tasks = [];
    foreach ($rows as $row) {
        $row = ints($row, ['id', 'property_id', 'room_id', 'created_by']);
        $row['images'] = [];
        $tasks[$row['id']] = $row;
    }
    $marks = implode(',', array_fill(0, count($tasks), '?'));
    $images = q("SELECT id, task_id, filename FROM images WHERE task_id IN ($marks) ORDER BY id", array_keys($tasks))->fetchAll();
    foreach ($images as $img) {
        $tasks[(int) $img['task_id']]['images'][] = [
            'id' => (int) $img['id'],
            'url' => 'api.php?r=image/' . $img['filename'],
        ];
    }
    return array_values($tasks);
}

function loadTask(int $id): array
{
    return loadTasks('WHERE t.id = ?', [$id])[0];
}

// ---------- Billeder ----------

function uploadedFiles(): array
{
    $f = $_FILES['images'] ?? null;
    if (!$f) return [];
    $files = [];
    if (is_array($f['name'])) {
        foreach ($f['name'] as $i => $name) {
            if ($f['error'][$i] === UPLOAD_ERR_NO_FILE) continue;
            $files[] = ['tmp_name' => $f['tmp_name'][$i], 'error' => $f['error'][$i], 'size' => $f['size'][$i]];
        }
    } elseif ($f['error'] !== UPLOAD_ERR_NO_FILE) {
        $files[] = $f;
    }
    if (count($files) > MAX_IMAGES) throw new HttpError(400, 'Højst ' . MAX_IMAGES . ' billeder ad gangen');
    foreach ($files as &$file) {
        if (in_array($file['error'], [UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE], true) || $file['size'] > MAX_IMAGE_BYTES) {
            throw new HttpError(400, 'Et billede er for stort (maks 15 MB)');
        }
        if ($file['error'] !== UPLOAD_ERR_OK || !is_uploaded_file($file['tmp_name'])) {
            throw new HttpError(400, 'Fejl ved upload af billede');
        }
        $mime = function_exists('finfo_open')
            ? (new finfo(FILEINFO_MIME_TYPE))->file($file['tmp_name'])
            : ((getimagesize($file['tmp_name']) ?: [])['mime'] ?? '');
        if (!isset(IMAGE_TYPES[$mime])) throw new HttpError(400, 'Kun billeder (JPG, PNG, WEBP, GIF, HEIC) er tilladt');
        $file['ext'] = IMAGE_TYPES[$mime];
    }
    unset($file);
    return $files;
}

function saveImages(int $taskId, array $files): void
{
    if (!$files) return;
    if (!is_dir(uploadDir()) && !mkdir(uploadDir(), 0755, true)) throw new HttpError(500, 'Kan ikke oprette mappen til billeder');
    foreach ($files as $file) {
        $name = bin2hex(random_bytes(16)) . '.' . $file['ext'];
        if (!move_uploaded_file($file['tmp_name'], uploadDir() . '/' . $name)) {
            throw new HttpError(500, 'Kunne ikke gemme billedet');
        }
        q('INSERT INTO images (task_id, filename, created_at) VALUES (?, ?, ?)', [$taskId, $name, now()]);
    }
}

function serveImage(string $filename): never
{
    requireUser();
    if (!preg_match('/^[a-f0-9]{32}\.(jpg|png|webp|gif|heic|heif)$/', $filename, $m)) throw new HttpError(404, 'Ikke fundet');
    $path = uploadDir() . '/' . $filename;
    if (!is_file($path)) throw new HttpError(404, 'Ikke fundet');
    $types = array_flip(IMAGE_TYPES);
    header('Content-Type: ' . $types[$m[1]]);
    header('Content-Length: ' . filesize($path));
    header('Cache-Control: private, max-age=31536000, immutable');
    readfile($path);
    exit;
}

// ---------- Installation ----------

function writeProtectedDir(string $dir): void
{
    if (!is_dir($dir) && !mkdir($dir, 0755, true)) throw new HttpError(500, "Kan ikke oprette mappen $dir - tjek rettigheder");
    file_put_contents("$dir/.htaccess", "<IfModule mod_authz_core.c>\n  Require all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\n  Order allow,deny\n  Deny from all\n</IfModule>\n");
    file_put_contents("$dir/index.html", '');
}

function install(array $body): never
{
    if (config()) throw new HttpError(403, 'Siden er allerede installeret');
    [$username, $password] = validateCredentials($body);
    $driver = oneOf($body['driver'] ?? '', ['sqlite', 'mysql'], 'database');

    writeProtectedDir(DATA_DIR);
    writeProtectedDir(DATA_DIR . '/uploads');

    if ($driver === 'sqlite') {
        if (!extension_loaded('pdo_sqlite')) throw new HttpError(400, 'SQLite er ikke tilgængelig på serveren - vælg MySQL');
        $config = ['driver' => 'sqlite', 'sqlite_path' => DATA_DIR . '/db-' . bin2hex(random_bytes(8)) . '.sqlite'];
    } else {
        $config = [
            'driver' => 'mysql',
            'mysql_host' => text($body['mysql_host'] ?? '', 200, 'Databaseserver', true),
            'mysql_name' => text($body['mysql_name'] ?? '', 200, 'Databasenavn', true),
            'mysql_user' => text($body['mysql_user'] ?? '', 200, 'Databasebruger', true),
            'mysql_pass' => is_string($body['mysql_pass'] ?? null) ? $body['mysql_pass'] : '',
        ];
    }

    try {
        $pdo = connect($config);
    } catch (PDOException $e) {
        throw new HttpError(400, 'Kunne ikke forbinde til databasen: ' . $e->getMessage());
    }
    createSchema($pdo, $driver);
    if ($pdo->query('SELECT COUNT(*) FROM users')->fetchColumn() > 0) {
        throw new HttpError(400, 'Databasen indeholder allerede brugere. Brug en tom database.');
    }

    $php = "<?php\n// Oprettet af installationen. Må ikke lægges på GitHub.\nreturn " . var_export($config, true) . ";\n";
    if (file_put_contents(CONFIG_FILE, $php, LOCK_EX) === false) {
        throw new HttpError(500, 'Kunne ikke gemme config.php - tjek at mappen er skrivbar');
    }
    @chmod(CONFIG_FILE, 0600);

    $stmt = $pdo->prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)');
    $stmt->execute([$username, password_hash($password, PASSWORD_DEFAULT), now()]);
    $userId = (int) $pdo->lastInsertId();

    $token = bin2hex(random_bytes(32));
    $expires = time() + SESSION_DAYS * 86400;
    $pdo->prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')->execute([$token, $userId, $expires]);
    setSessionCookie($token, $expires);
    respond(['user' => ['id' => $userId, 'username' => $username]]);
}

// ---------- Routing ----------

$method = $_SERVER['REQUEST_METHOD'];
if ($method === 'POST' && isset($_SERVER['HTTP_X_HTTP_METHOD_OVERRIDE'])) {
    $method = strtoupper($_SERVER['HTTP_X_HTTP_METHOD_OVERRIDE']);
}
$route = trim((string) ($_GET['r'] ?? ''), '/');
$parts = $route === '' ? [] : explode('/', $route);

if (($parts[0] ?? '') === 'image' && $method === 'GET') serveImage($parts[1] ?? '');

$isJson = str_contains($_SERVER['CONTENT_TYPE'] ?? '', 'application/json');
if ($isJson) {
    $raw = (string) file_get_contents('php://input');
    $body = $raw === '' ? [] : json_decode($raw, true);
    if (!is_array($body)) throw new HttpError(400, 'Ugyldig forespørgsel');
} else {
    $body = $_POST;
    if (!$body && !$_FILES && (int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 0) {
        throw new HttpError(400, 'Billederne fylder for meget til én upload - prøv med færre ad gangen');
    }
}

$ids = array_values(array_filter($parts, 'ctype_digit'));
$id = isset($ids[0]) ? (int) $ids[0] : 0;
$key = $method . ' ' . implode('/', array_map(fn($p) => ctype_digit($p) ? ':id' : $p, $parts));

// --- Uden login ---

switch ($key) {
    case 'GET status':
        if (!config()) {
            respond(['installNeeded' => true, 'sqliteAvailable' => extension_loaded('pdo_sqlite'), 'user' => null]);
        }
        respond([
            'installNeeded' => false,
            'setupNeeded' => (int) q('SELECT COUNT(*) FROM users')->fetchColumn() === 0,
            'user' => currentUser(),
        ]);

    case 'POST install':
        install($body);

    case 'POST setup':
        if ((int) q('SELECT COUNT(*) FROM users')->fetchColumn() > 0) throw new HttpError(403, 'Der findes allerede en bruger');
        [$username, $password] = validateCredentials($body);
        q('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)', [$username, password_hash($password, PASSWORD_DEFAULT), now()]);
        $userId = lastId();
        createSession($userId);
        respond(['user' => ['id' => $userId, 'username' => $username]]);

    case 'POST login':
        $ip = clientIp();
        if (loginBlocked($ip)) throw new HttpError(429, 'For mange forsøg. Prøv igen om 15 minutter.');
        $username = is_string($body['username'] ?? null) ? trim($body['username']) : '';
        $password = is_string($body['password'] ?? null) ? $body['password'] : '';
        $user = $username === '' ? null : findUserByName($username);
        if (!$user || !password_verify($password, $user['password_hash'])) {
            registerFailedLogin($ip);
            throw new HttpError(401, 'Forkert brugernavn eller adgangskode');
        }
        q('DELETE FROM login_failures WHERE ip = ?', [$ip]);
        q('DELETE FROM sessions WHERE expires_at < ?', [time()]);
        createSession((int) $user['id']);
        respond(['user' => ['id' => (int) $user['id'], 'username' => $user['username']]]);

    case 'POST logout':
        $token = $_COOKIE['sid'] ?? '';
        if (is_string($token) && $token !== '' && config()) q('DELETE FROM sessions WHERE token = ?', [$token]);
        setSessionCookie('', time() - 3600);
        respond(['ok' => true]);
}

// --- Kræver login ---

$me = requireUser();

switch ($key) {
    // Brugere
    case 'GET users':
        respond(array_map(fn($u) => ints($u, ['id']), q('SELECT id, username, created_at FROM users ORDER BY LOWER(username)')->fetchAll()));

    case 'POST users':
        [$username, $password] = validateCredentials($body);
        if (findUserByName($username)) throw new HttpError(400, 'Brugernavnet er allerede taget');
        q('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)', [$username, password_hash($password, PASSWORD_DEFAULT), now()]);
        respond(['id' => lastId(), 'username' => $username]);

    case 'DELETE users/:id':
        if ($id === $me['id']) throw new HttpError(400, 'Du kan ikke slette dig selv');
        if (!q('DELETE FROM users WHERE id = ?', [$id])->rowCount()) throw new HttpError(404, 'Brugeren findes ikke');
        respond(['ok' => true]);

    case 'POST me/password':
        $user = q('SELECT * FROM users WHERE id = ?', [$me['id']])->fetch();
        $current = is_string($body['currentPassword'] ?? null) ? $body['currentPassword'] : '';
        if (!password_verify($current, $user['password_hash'])) throw new HttpError(400, 'Nuværende adgangskode er forkert');
        [, $password] = validateCredentials(['username' => $user['username'], 'password' => $body['newPassword'] ?? '']);
        q('UPDATE users SET password_hash = ? WHERE id = ?', [password_hash($password, PASSWORD_DEFAULT), $me['id']]);
        respond(['ok' => true]);

    // Boliger og rum
    case 'GET properties':
        $properties = q("SELECT p.*,
                (SELECT COUNT(*) FROM tasks t WHERE t.property_id = p.id AND t.status <> 'faerdig') AS open_count,
                (SELECT COUNT(*) FROM tasks t WHERE t.property_id = p.id) AS total_count
            FROM properties p ORDER BY LOWER(p.name)")->fetchAll();
        $rooms = array_map(fn($r) => ints($r, ['id', 'property_id']), q('SELECT * FROM rooms ORDER BY id')->fetchAll());
        $out = [];
        foreach ($properties as $p) {
            $p = ints($p, ['id', 'open_count', 'total_count']);
            $p['rooms'] = array_values(array_filter($rooms, fn($r) => $r['property_id'] === $p['id']));
            $out[] = $p;
        }
        respond($out);

    case 'POST properties':
    case 'PUT properties/:id':
        $name = text($body['name'] ?? '', 80, 'Navn', true);
        $type = oneOf($body['type'] ?? '', PROPERTY_TYPES, 'boligtype');
        $address = text($body['address'] ?? '', 200, 'Adresse');
        if ($method === 'PUT') {
            $p = getProperty($id);
            q('UPDATE properties SET name = ?, type = ?, address = ? WHERE id = ?', [$name, $type, $address, $p['id']]);
            respond(['ok' => true]);
        }
        q('INSERT INTO properties (name, type, address, created_at) VALUES (?, ?, ?, ?)', [$name, $type, $address, now()]);
        $propertyId = lastId();
        if (!empty($body['defaultRooms'])) {
            foreach (DEFAULT_ROOMS as [$roomName, $roomType]) {
                q('INSERT INTO rooms (property_id, name, type) VALUES (?, ?, ?)', [$propertyId, $roomName, $roomType]);
            }
        }
        respond(['id' => $propertyId]);

    case 'DELETE properties/:id':
        $p = getProperty($id);
        $files = q('SELECT i.filename FROM images i JOIN tasks t ON t.id = i.task_id WHERE t.property_id = ?', [$p['id']])->fetchAll(PDO::FETCH_COLUMN);
        q('DELETE FROM properties WHERE id = ?', [$p['id']]);
        removeFiles($files);
        respond(['ok' => true]);

    case 'POST properties/:id/rooms':
        $p = getProperty($id);
        q('INSERT INTO rooms (property_id, name, type) VALUES (?, ?, ?)', [
            $p['id'],
            text($body['name'] ?? '', 60, 'Navn på rum', true),
            oneOf($body['type'] ?? '', ROOM_TYPES, 'rumtype'),
        ]);
        respond(['id' => lastId()]);

    case 'PUT rooms/:id':
        $name = text($body['name'] ?? '', 60, 'Navn på rum', true);
        $type = oneOf($body['type'] ?? '', ROOM_TYPES, 'rumtype');
        if (!q('SELECT id FROM rooms WHERE id = ?', [$id])->fetch()) throw new HttpError(404, 'Rummet findes ikke');
        q('UPDATE rooms SET name = ?, type = ? WHERE id = ?', [$name, $type, $id]);
        respond(['ok' => true]);

    case 'DELETE rooms/:id':
        if (!q('DELETE FROM rooms WHERE id = ?', [$id])->rowCount()) throw new HttpError(404, 'Rummet findes ikke');
        respond(['ok' => true]);

    // Opgaver
    case 'GET tasks':
        respond(loadTasks());

    case 'POST tasks':
        $property = getProperty($body['property_id'] ?? '');
        $roomId = checkRoom($body['room_id'] ?? null, $property['id']);
        $title = text($body['title'] ?? '', 150, 'Titel', true);
        $description = text($body['description'] ?? '', 5000, 'Beskrivelse');
        $status = oneOf($body['status'] ?? 'mangler', STATUSES, 'status');
        $priority = oneOf($body['priority'] ?? 'normal', PRIORITIES, 'prioritet');
        $files = uploadedFiles();
        q('INSERT INTO tasks (property_id, room_id, title, description, status, priority, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [$property['id'], $roomId, $title, $description, $status, $priority, $me['id'], now(), now()]);
        $taskId = lastId();
        saveImages($taskId, $files);
        respond(loadTask($taskId));

    case 'PUT tasks/:id':
        $t = getTaskRow($id);
        $b = array_merge($t, $body);
        $property = getProperty($b['property_id']);
        $roomId = checkRoom($b['room_id'], $property['id']);
        q('UPDATE tasks SET property_id = ?, room_id = ?, title = ?, description = ?, status = ?, priority = ?, updated_at = ?
           WHERE id = ?', [
            $property['id'],
            $roomId,
            text($b['title'], 150, 'Titel', true),
            text($b['description'], 5000, 'Beskrivelse'),
            oneOf($b['status'], STATUSES, 'status'),
            oneOf($b['priority'], PRIORITIES, 'prioritet'),
            now(),
            $t['id'],
        ]);
        respond(loadTask($t['id']));

    case 'DELETE tasks/:id':
        $t = getTaskRow($id);
        $files = q('SELECT filename FROM images WHERE task_id = ?', [$t['id']])->fetchAll(PDO::FETCH_COLUMN);
        q('DELETE FROM tasks WHERE id = ?', [$t['id']]);
        removeFiles($files);
        respond(['ok' => true]);

    case 'POST tasks/:id/images':
        $t = getTaskRow($id);
        saveImages($t['id'], uploadedFiles());
        q('UPDATE tasks SET updated_at = ? WHERE id = ?', [now(), $t['id']]);
        respond(loadTask($t['id']));

    case 'DELETE images/:id':
        $img = q('SELECT * FROM images WHERE id = ?', [$id])->fetch();
        if (!$img) throw new HttpError(404, 'Billedet findes ikke');
        q('DELETE FROM images WHERE id = ?', [$img['id']]);
        removeFiles([$img['filename']]);
        respond(loadTask((int) $img['task_id']));
}

throw new HttpError(404, 'Ikke fundet');
