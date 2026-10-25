package panel

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	_ "modernc.org/sqlite"
	"site-panel/internal/node"
)

type Store struct {
	db     *sql.DB
	secret cipher.AEAD
	Dir    string
	lock   *os.File
}
type Node struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Host        string `json:"host"`
	Port        int    `json:"port"`
	User        string `json:"user"`
	Fingerprint string `json:"fingerprint"`
	Note        string `json:"note"`
}
type Site struct {
	node.Site
	NodeID  string                `json:"node_id"`
	Enabled bool                  `json:"enabled"`
	Vars    map[string]string     `json:"vars,omitempty"`
	SSL     *node.CertificateInfo `json:"ssl,omitempty"`
}
type Task struct {
	Kind      string `json:"kind"`
	ID        string `json:"id"`
	NodeID    string `json:"node_id"`
	SiteID    string `json:"site_id"`
	Status    string `json:"status"`
	Step      string `json:"step"`
	Error     string `json:"error,omitempty"`
	UpdatedAt string `json:"updated_at"`
}

func ID() string {
	b := make([]byte, 16)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}
func Open(dir, keyPath string) (*Store, error) {
	if e := os.MkdirAll(dir, 0700); e != nil {
		return nil, e
	}
	if e := os.Chmod(dir, 0700); e != nil {
		return nil, e
	}
	lock, e := os.OpenFile(filepath.Join(dir, "panel.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, e
	}
	if e = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		lock.Close()
		return nil, errors.New("此数据目录已有主控运行，不能同时启动两份")
	}
	opened := false
	defer func() {
		if !opened {
			lock.Close()
		}
	}()
	key, e := os.ReadFile(keyPath)
	if os.IsNotExist(e) {
		if _, dbErr := os.Stat(filepath.Join(dir, "panel.db")); dbErr == nil {
			return nil, errors.New("数据库已存在但加密密钥丢失；请恢复原密钥，不会自动生成新密钥")
		} else if !os.IsNotExist(dbErr) {
			return nil, dbErr
		}
		key = make([]byte, 32)
		if _, e = rand.Read(key); e != nil {
			return nil, e
		}
		if e = os.MkdirAll(filepath.Dir(keyPath), 0700); e != nil {
			return nil, e
		}
		var f *os.File
		f, e = os.OpenFile(keyPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			return nil, e
		}
		_, e = f.Write(key)
		if e == nil {
			e = f.Sync()
		}
		ce := f.Close()
		if e == nil {
			e = ce
		}
	}
	if e != nil {
		return nil, e
	}
	if len(key) != 32 {
		return nil, errors.New("加密密钥必须为 32 字节")
	}
	block, e := aes.NewCipher(key)
	if e != nil {
		return nil, e
	}
	aead, e := cipher.NewGCM(block)
	if e != nil {
		return nil, e
	}
	db, e := sql.Open("sqlite", filepath.Join(dir, "panel.db"))
	if e != nil {
		return nil, e
	}
	db.SetMaxOpenConns(1)
	s := &Store{db: db, secret: aead, Dir: dir, lock: lock}
	_, e = db.Exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
 CREATE TABLE IF NOT EXISTS account(id INTEGER PRIMARY KEY CHECK(id=1), hash BLOB NOT NULL);
 CREATE TABLE IF NOT EXISTS session(id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS nodes(id TEXT PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL, username TEXT NOT NULL, fingerprint TEXT NOT NULL, note TEXT NOT NULL, password BLOB NOT NULL);
 CREATE TABLE IF NOT EXISTS sites(id TEXT PRIMARY KEY, node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL, spec BLOB NOT NULL);
 CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, node_id TEXT NOT NULL, site_id TEXT NOT NULL, status TEXT NOT NULL, step TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS task_events(id INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), status TEXT NOT NULL, step TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id,id);
 CREATE INDEX IF NOT EXISTS tasks_by_node ON tasks(node_id);
 CREATE TABLE IF NOT EXISTS certificates(site_id TEXT PRIMARY KEY REFERENCES sites(id), info TEXT NOT NULL, encrypted BLOB NOT NULL);
 CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS secrets(key TEXT PRIMARY KEY, value BLOB NOT NULL);`)
	if e != nil {
		db.Close()
		return nil, e
	}
	rows, e := db.Query(`PRAGMA table_info(tasks)`)
	if e != nil {
		db.Close()
		return nil, e
	}
	hasKind := false
	for rows.Next() {
		var cid, nn, pk int
		var name, typ string
		var def sql.NullString
		if e = rows.Scan(&cid, &name, &typ, &nn, &def, &pk); e != nil {
			rows.Close()
			db.Close()
			return nil, e
		}
		hasKind = hasKind || name == "kind"
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		db.Close()
		return nil, e
	}
	if !hasKind {
		if _, e = db.Exec(`ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'deploy'`); e != nil {
			db.Close()
			return nil, e
		}
	}
	// Local in-flight work cannot survive a controller restart. Remote systemd
	// tasks may still be running and must be queried rather than resubmitted.
	_, e = db.Exec(`UPDATE tasks SET status='needs_attention',error='主控曾中断，请核实节点实际结果后再操作' WHERE status IN ('queued','running') AND (site_id='' OR step='prepare')`)
	if e != nil {
		db.Close()
		return nil, e
	}
	opened = true
	return s, nil
}
func (s *Store) Close() error { return errors.Join(s.db.Close(), s.lock.Close()) }
func (s *Store) GetSetting(key string) (string, error) {
	var v sql.NullString
	e := s.db.QueryRow(`SELECT value FROM settings WHERE key=?`, key).Scan(&v)
	if e == sql.ErrNoRows {
		return "", nil
	}
	if e != nil {
		return "", e
	}
	return v.String, nil
}
func (s *Store) SetSetting(key, value string) error {
	_, e := s.db.Exec(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value)
	return e
}
func (s *Store) DeleteSetting(key string) error {
	_, e := s.db.Exec(`DELETE FROM settings WHERE key=?`, key)
	return e
}
func (s *Store) GetSecret(key string) (string, error) {
	var b []byte
	e := s.db.QueryRow(`SELECT value FROM secrets WHERE key=?`, key).Scan(&b)
	if e == sql.ErrNoRows {
		return "", nil
	}
	if e != nil {
		return "", e
	}
	size := s.secret.NonceSize()
	if len(b) < size {
		return "", errors.New("invalid encrypted secret")
	}
	p, e := s.secret.Open(nil, b[:size], b[size:], []byte(key))
	if e != nil {
		return "", e
	}
	return string(p), nil
}
func (s *Store) SetSecret(key, value string) error {
	b, e := s.seal(key, value)
	if e != nil {
		return e
	}
	_, e = s.db.Exec(`INSERT INTO secrets(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, b)
	return e
}
func (s *Store) DeleteSecret(key string) error {
	_, e := s.db.Exec(`DELETE FROM secrets WHERE key=?`, key)
	return e
}

type NodeStatus struct {
	Nginx      string `json:"nginx,omitempty"`
	Version    string `json:"version,omitempty"`
	ObservedAt string `json:"observed_at,omitempty"`
	Error      string `json:"error,omitempty"`
}

func nodeStatusKey(id string) string { return "node_status:" + id }

func (s *Store) SaveNodeStatus(id string, st NodeStatus) error {
	b, e := json.Marshal(st)
	if e != nil {
		return e
	}
	return s.SetSetting(nodeStatusKey(id), string(b))
}

func (s *Store) GetNodeStatus(id string) (NodeStatus, error) {
	var out NodeStatus
	raw, e := s.GetSetting(nodeStatusKey(id))
	if e != nil || raw == "" {
		return out, e
	}
	_ = json.Unmarshal([]byte(raw), &out)
	return out, nil
}

func (s *Store) NodeStatuses() (map[string]NodeStatus, error) {
	rows, e := s.db.Query(`SELECT key,value FROM settings WHERE key LIKE 'node_status:%'`)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := map[string]NodeStatus{}
	for rows.Next() {
		var key, value string
		if e = rows.Scan(&key, &value); e != nil {
			return nil, e
		}
		id := strings.TrimPrefix(key, "node_status:")
		var st NodeStatus
		_ = json.Unmarshal([]byte(value), &st)
		out[id] = st
	}
	return out, rows.Err()
}

func (s *Store) seal(id, password string) ([]byte, error) {
	nonce := make([]byte, s.secret.NonceSize())
	if _, e := rand.Read(nonce); e != nil {
		return nil, e
	}
	return s.secret.Seal(nonce, nonce, []byte(password), []byte(id)), nil
}
func (s *Store) SaveNode(n Node, password string) error {
	b, e := s.seal(n.ID, password)
	if e != nil {
		return e
	}
	_, e = s.db.Exec(`INSERT INTO nodes VALUES(?,?,?,?,?,?,?,?)`, n.ID, n.Name, n.Host, n.Port, n.User, n.Fingerprint, n.Note, b)
	return e
}
func (s *Store) UpdateNodeMeta(id, name, note string) error {
	_, e := s.db.Exec(`UPDATE nodes SET name=?, note=? WHERE id=?`, name, note, id)
	return e
}
func (s *Store) UpdateNodePassword(id, password string) error {
	if strings.TrimSpace(password) == "" {
		return errors.New("密码不能为空")
	}
	b, e := s.seal(id, password)
	if e != nil {
		return e
	}
	_, e = s.db.Exec(`UPDATE nodes SET password=? WHERE id=?`, b, id)
	return e
}
func (s *Store) UpdateNodeFingerprint(id, fingerprint string) error {
	if !strings.HasPrefix(fingerprint, "SHA256:") {
		return errors.New("invalid fingerprint")
	}
	_, e := s.db.Exec(`UPDATE nodes SET fingerprint=? WHERE id=?`, fingerprint, id)
	return e
}
func (s *Store) GetNode(id string) (Node, string, error) {
	var n Node
	var b []byte
	e := s.db.QueryRow(`SELECT id,name,host,port,username,fingerprint,note,password FROM nodes WHERE id=?`, id).Scan(&n.ID, &n.Name, &n.Host, &n.Port, &n.User, &n.Fingerprint, &n.Note, &b)
	if e != nil {
		return n, "", e
	}
	size := s.secret.NonceSize()
	if len(b) < size {
		return n, "", errors.New("invalid encrypted password")
	}
	p, e := s.secret.Open(nil, b[:size], b[size:], []byte(id))
	return n, string(p), e
}
func (s *Store) Nodes() ([]Node, error) {
	rows, e := s.db.Query(`SELECT id,name,host,port,username,fingerprint,note FROM nodes ORDER BY rowid DESC`)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []Node{}
	for rows.Next() {
		var n Node
		if e = rows.Scan(&n.ID, &n.Name, &n.Host, &n.Port, &n.User, &n.Fingerprint, &n.Note); e != nil {
			return nil, e
		}
		out = append(out, n)
	}
	return out, rows.Err()
}
func (s *Store) Sites() ([]Site, error) {
	rows, e := s.db.Query(`SELECT s.id,s.node_id,s.spec,c.info FROM sites s LEFT JOIN certificates c ON c.site_id=s.id ORDER BY s.rowid DESC`)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []Site{}
	for rows.Next() {
		var id string
		var nid sql.NullString
		var b []byte
		var cert sql.NullString
		if e = rows.Scan(&id, &nid, &b, &cert); e != nil {
			return nil, e
		}
		spec, enabled, vars, e := decodeSiteSpec(b)
		if e != nil {
			return nil, e
		}
		v := Site{Site: spec, NodeID: nid.String, Enabled: enabled, Vars: vars}
		if cert.Valid {
			v.SSL = &node.CertificateInfo{}
			if e = json.Unmarshal([]byte(cert.String), v.SSL); e != nil {
				return nil, e
			}
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func (s *Store) GetSite(id string) (Site, error) {
	var nid sql.NullString
	var b []byte
	var cert sql.NullString
	e := s.db.QueryRow(`SELECT node_id,spec,(SELECT info FROM certificates WHERE site_id=sites.id) FROM sites WHERE id=?`, id).Scan(&nid, &b, &cert)
	if e != nil {
		return Site{}, e
	}
	spec, enabled, vars, e := decodeSiteSpec(b)
	if e != nil {
		return Site{}, e
	}
	v := Site{Site: spec, NodeID: nid.String, Enabled: enabled, Vars: vars}
	if cert.Valid {
		v.SSL = &node.CertificateInfo{}
		e = json.Unmarshal([]byte(cert.String), v.SSL)
	}
	return v, e
}
func (s *Store) SaveSite(v Site) error {
	// Create path is always enabled; disable/enable go through UpdateSite.
	b, e := encodeSiteSpec(v.Site, true, v.Vars)
	if e != nil {
		return e
	}
	var nodeID any = v.NodeID
	if v.NodeID == "" {
		nodeID = nil
	}
	_, e = s.db.Exec(`INSERT INTO sites(id,node_id,spec) VALUES(?,?,?)`, v.ID, nodeID, b)
	return e
}
func (s *Store) BindSite(id, nodeID string) error {
	var nid any = nodeID
	if nodeID == "" {
		nid = nil
	}
	result, e := s.db.Exec(`UPDATE sites SET node_id=? WHERE id=?`, nid, id)
	if e != nil {
		return e
	}
	n, e := result.RowsAffected()
	if e == nil && n != 1 {
		return errors.New("站点不存在")
	}
	return e
}
func (s *Store) DeleteSite(id string) error {
	tx, e := s.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if _, e = tx.Exec(`DELETE FROM certificates WHERE site_id=?`, id); e != nil {
		return e
	}
	result, e := tx.Exec(`DELETE FROM sites WHERE id=?`, id)
	if e != nil {
		return e
	}
	n, e := result.RowsAffected()
	if e != nil {
		return e
	}
	if n != 1 {
		return errors.New("站点不存在")
	}
	return tx.Commit()
}
func (s *Store) SiteHasActiveTask(siteID string) (bool, error) {
	var n int
	e := s.db.QueryRow(`SELECT COUNT(1) FROM tasks WHERE site_id=? AND status IN ('queued','running')`, siteID).Scan(&n)
	return n > 0, e
}
func (s *Store) NewTask(t Task) error {
	if t.Kind == "" {
		t.Kind = "deploy"
		if t.SiteID == "" {
			t.Kind = "install"
		}
	}
	tx, e := s.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	now := time.Now().UTC().Format(time.RFC3339)
	if _, e = tx.Exec(`INSERT INTO tasks(id,node_id,site_id,status,step,error,updated_at,kind) VALUES(?,?,?,?,?,?,?,?)`, t.ID, t.NodeID, t.SiteID, t.Status, t.Step, t.Error, now, t.Kind); e != nil {
		return e
	}
	if _, e = tx.Exec(`INSERT INTO task_events(task_id,status,step,message,created_at) VALUES(?,?,?,?,?)`, t.ID, t.Status, t.Step, t.Error, now); e != nil {
		return e
	}
	return tx.Commit()
}
func (s *Store) DismissTask(id string) error {
	t, e := s.GetTask(id)
	if e != nil {
		return e
	}
	if t.Status != "needs_attention" {
		return errors.New("只有待核实任务可以清除")
	}
	msg := strings.TrimSpace(t.Error)
	if msg == "" {
		msg = "已忽略"
	} else if !strings.HasPrefix(msg, "已忽略") {
		msg = "已忽略：" + msg
	}
	return s.SetTask(id, "dismissed", t.Step, msg)
}

func (s *Store) DismissNodeAttention(nodeID string) (int, error) {
	rows, e := s.db.Query(`SELECT id FROM tasks WHERE node_id=? AND status='needs_attention'`, nodeID)
	if e != nil {
		return 0, e
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if e = rows.Scan(&id); e != nil {
			return 0, e
		}
		ids = append(ids, id)
	}
	if e = rows.Err(); e != nil {
		return 0, e
	}
	for _, id := range ids {
		if e = s.DismissTask(id); e != nil {
			return 0, e
		}
	}
	return len(ids), nil
}

func (s *Store) SetTask(id, status, step, message string) error {
	tx, e := s.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var oldStatus, oldStep, oldMessage string
	if e = tx.QueryRow(`SELECT status,step,error FROM tasks WHERE id=?`, id).Scan(&oldStatus, &oldStep, &oldMessage); e != nil {
		return e
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if _, e = tx.Exec(`UPDATE tasks SET status=?,step=?,error=?,updated_at=? WHERE id=?`, status, step, message, now, id); e != nil {
		return e
	}
	if oldStatus != status || oldStep != step || oldMessage != message {
		if _, e = tx.Exec(`INSERT INTO task_events(task_id,status,step,message,created_at) VALUES(?,?,?,?,?)`, id, status, step, message, now); e != nil {
			return e
		}
	}
	return tx.Commit()
}

type TaskEvent struct {
	Status    string
	Step      string
	Message   string
	CreatedAt string
}

func (s *Store) TaskEvents(id string) ([]TaskEvent, error) {
	rows, e := s.db.Query(`SELECT status,step,message,created_at FROM (SELECT id,status,step,message,created_at FROM task_events WHERE task_id=? ORDER BY id DESC LIMIT 100) ORDER BY id`, id)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	events := []TaskEvent{}
	for rows.Next() {
		var v TaskEvent
		if e = rows.Scan(&v.Status, &v.Step, &v.Message, &v.CreatedAt); e != nil {
			return nil, e
		}
		events = append(events, v)
	}
	return events, rows.Err()
}
func (s *Store) GetTask(id string) (Task, error) {
	var t Task
	e := s.db.QueryRow(`SELECT id,node_id,site_id,status,step,error,updated_at,kind FROM tasks WHERE id=?`, id).Scan(&t.ID, &t.NodeID, &t.SiteID, &t.Status, &t.Step, &t.Error, &t.UpdatedAt, &t.Kind)
	return t, e
}
func (s *Store) Tasks(nodeID ...string) ([]Task, error) {
	query := `SELECT id,node_id,site_id,status,step,error,updated_at,kind FROM tasks`
	args := []any{}
	if len(nodeID) > 0 && nodeID[0] != "" {
		query += ` WHERE node_id=?`
		args = append(args, nodeID[0])
	}
	query += ` ORDER BY rowid DESC LIMIT 50`
	rows, e := s.db.Query(query, args...)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []Task{}
	for rows.Next() {
		var t Task
		if e = rows.Scan(&t.ID, &t.NodeID, &t.SiteID, &t.Status, &t.Step, &t.Error, &t.UpdatedAt, &t.Kind); e != nil {
			return nil, e
		}
		out = append(out, t)
	}
	return out, rows.Err()
}
