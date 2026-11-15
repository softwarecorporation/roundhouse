use crate::config::Limits;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Mutex;

pub type DbResult<T> = Result<T, rusqlite::Error>;

pub struct Store(Mutex<Connection>);

#[derive(Clone, Serialize)]
pub struct Incident {
    pub id: String,
    pub monitor: String,
    pub state: String,
    pub pending_action: Option<String>,
    pub created_at: String,
}

impl Store {
    pub fn open(path: &str) -> DbResult<Self> {
        let c = Connection::open(path)?;
        c.busy_timeout(std::time::Duration::from_secs(5))?;
        c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS incidents (
                id TEXT PRIMARY KEY, monitor TEXT NOT NULL, state TEXT NOT NULL,
                pending_action TEXT, approved_action TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
            CREATE UNIQUE INDEX IF NOT EXISTS active_monitor ON incidents(monitor) WHERE state != 'resolved';
            CREATE TABLE IF NOT EXISTS audit (
                seq INTEGER PRIMARY KEY, incident TEXT NOT NULL REFERENCES incidents(id),
                kind TEXT NOT NULL, detail TEXT NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now')));
            CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, monitor TEXT NOT NULL, incident TEXT NOT NULL REFERENCES incidents(id));
            CREATE TABLE IF NOT EXISTS requests (incident TEXT NOT NULL REFERENCES incidents(id),
                day TEXT NOT NULL, reserved INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS actions (incident TEXT PRIMARY KEY REFERENCES incidents(id),
                day TEXT NOT NULL, name TEXT NOT NULL, outcome TEXT NOT NULL);")?;
        Ok(Self(Mutex::new(c)))
    }

    pub fn recover_interrupted(&self) -> DbResult<()> {
        let mut c = self.0.lock().unwrap();
        let tx = c.transaction()?;
        tx.execute("INSERT INTO audit(incident,kind,detail) SELECT id,'interrupted','{\"reason\":\"service restarted; no action replay\"}' FROM incidents WHERE state='investigating'", [])?;
        tx.execute("UPDATE incidents SET state='needs_attention', approved_action=NULL WHERE state='investigating'", [])?;
        tx.commit()
    }

    pub fn enqueue(&self, monitor: &str, event: Option<&str>) -> DbResult<String> {
        let mut c = self.0.lock().unwrap();
        let tx = c.transaction()?;
        if let Some(event) = event {
            if let Some((id, original)) = tx
                .query_row(
                    "SELECT incident,monitor FROM events WHERE id=?",
                    [event],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                )
                .optional()?
            {
                if original != monitor {
                    return Err(rusqlite::Error::InvalidQuery);
                }
                return Ok(id);
            }
        }
        let id: Option<String> = tx
            .query_row(
                "SELECT id FROM incidents WHERE monitor=? AND state!='resolved'",
                [monitor],
                |r| r.get(0),
            )
            .optional()?;
        let id = match id {
            Some(id) => id,
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO incidents(id,monitor,state) VALUES(?,?,'queued')",
                    params![id, monitor],
                )?;
                tx.execute(
                    "INSERT INTO audit(incident,kind,detail) VALUES(?,'detected','{}')",
                    [&id],
                )?;
                id
            }
        };
        if let Some(event) = event {
            tx.execute(
                "INSERT INTO events(id,monitor,incident) VALUES(?,?,?)",
                params![event, monitor, id],
            )?;
            tx.execute(
                "INSERT INTO audit(incident,kind,detail) VALUES(?,'event_received','{}')",
                [&id],
            )?;
        }
        tx.commit()?;
        Ok(id)
    }

    pub fn list(&self) -> DbResult<Vec<Incident>> {
        let c = self.0.lock().unwrap();
        let mut stmt = c.prepare("SELECT id,monitor,state,pending_action,created_at FROM incidents ORDER BY rowid DESC LIMIT 200")?;
        let rows = stmt.query_map([], |r| {
            Ok(Incident {
                id: r.get(0)?,
                monitor: r.get(1)?,
                state: r.get(2)?,
                pending_action: r.get(3)?,
                created_at: r.get(4)?,
            })
        })?;
        rows.collect()
    }

    pub fn claim(&self) -> DbResult<Option<Incident>> {
        let mut c = self.0.lock().unwrap();
        let tx = c.transaction()?;
        let id: Option<String> = tx
            .query_row(
                "SELECT id FROM incidents WHERE state='queued' ORDER BY rowid LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(id) = id {
            tx.execute(
                "UPDATE incidents SET state='investigating' WHERE id=?",
                [&id],
            )?;
            let i = tx.query_row(
                "SELECT id,monitor,state,pending_action,created_at FROM incidents WHERE id=?",
                [&id],
                |r| {
                    Ok(Incident {
                        id: r.get(0)?,
                        monitor: r.get(1)?,
                        state: r.get(2)?,
                        pending_action: r.get(3)?,
                        created_at: r.get(4)?,
                    })
                },
            )?;
            tx.commit()?;
            Ok(Some(i))
        } else {
            Ok(None)
        }
    }

    pub fn audit(&self, id: &str, kind: &str, detail: Value) -> DbResult<()> {
        self.0.lock().unwrap().execute(
            "INSERT INTO audit(incident,kind,detail) VALUES(?,?,?)",
            params![id, kind, detail.to_string()],
        )?;
        Ok(())
    }

    pub fn history(&self, id: &str) -> DbResult<Vec<Value>> {
        let c = self.0.lock().unwrap();
        let mut s =
            c.prepare("SELECT seq,kind,detail,at FROM audit WHERE incident=? ORDER BY seq")?;
        let rows = s.query_map([id], |r| Ok(json!({"seq": r.get::<_,i64>(0)?, "kind":r.get::<_,String>(1)?,"detail":serde_json::from_str::<Value>(&r.get::<_,String>(2)?).unwrap_or(Value::Null),"at":r.get::<_,String>(3)?})))?;
        rows.collect()
    }

    pub fn finish(&self, id: &str, state: &str) -> DbResult<()> {
        let mut c = self.0.lock().unwrap();
        let tx = c.transaction()?;
        tx.execute(
            "UPDATE incidents SET state=?, approved_action=NULL WHERE id=?",
            params![state, id],
        )?;
        tx.execute(
            "INSERT INTO audit(incident,kind,detail) VALUES(?,'state',?)",
            params![id, json!({"state":state}).to_string()],
        )?;
        tx.commit()
    }

    pub fn request_approval(&self, id: &str, action: &str) -> DbResult<()> {
        self.0.lock().unwrap().execute(
            "UPDATE incidents SET pending_action=? WHERE id=? AND state='investigating'",
            params![action, id],
        )?;
        self.audit(id, "approval_required", json!({"action":action}))
    }

    pub fn approve(&self, id: &str, action: &str) -> DbResult<bool> {
        let mut c = self.0.lock().unwrap();
        let tx = c.transaction()?;
        let n = tx.execute("UPDATE incidents SET approved_action=?,state='queued' WHERE id=? AND state='awaiting_approval' AND pending_action=?", params![action,id,action])?;
        if n == 1 {
            tx.execute(
                "INSERT INTO audit(incident,kind,detail) VALUES(?,'approved',?)",
                params![id, json!({"action":action}).to_string()],
            )?;
        }
        tx.commit()?;
        Ok(n == 1)
    }

    pub fn reserve_request(&self, id: &str, limits: &Limits) -> Result<(), String> {
        let mut c = self.0.lock().unwrap();
        let tx = c.transaction().map_err(|_| "budget storage unavailable")?;
        let (count, reserved): (u32, u64) = tx
            .query_row(
                "SELECT count(*),coalesce(sum(reserved),0) FROM requests WHERE day=date('now')",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|_| "budget storage unavailable")?;
        let incident_count: u32 = tx
            .query_row(
                "SELECT count(*) FROM requests WHERE incident=?",
                [id],
                |r| r.get(0),
            )
            .map_err(|_| "budget storage unavailable")?;
        if count >= limits.daily_requests
            || incident_count >= limits.requests_per_incident
            || limits.reserve_per_request_microusd
                > limits.daily_budget_microusd.saturating_sub(reserved)
        {
            return Err("request or spending reservation limit reached".into());
        }
        tx.execute(
            "INSERT INTO requests VALUES(?,date('now'),?)",
            params![id, limits.reserve_per_request_microusd],
        )
        .map_err(|_| "budget storage unavailable")?;
        tx.execute(
            "INSERT INTO audit(incident,kind,detail) VALUES(?,'provider_request_reserved',?)",
            params![
                id,
                json!({"microusd":limits.reserve_per_request_microusd}).to_string()
            ],
        )
        .map_err(|_| "budget storage unavailable")?;
        tx.commit().map_err(|_| "budget storage unavailable".into())
    }

    // Claim is committed before network I/O. Unknown outcomes are never replayed.
    pub fn claim_action(
        &self,
        id: &str,
        name: &str,
        automatic: bool,
        daily_limit: u32,
    ) -> Result<(), String> {
        let mut c = self.0.lock().unwrap();
        let tx = c.transaction().map_err(|_| "action storage unavailable")?;
        let approved: Option<String> = tx
            .query_row(
                "SELECT approved_action FROM incidents WHERE id=? AND state='investigating'",
                [id],
                |r| r.get(0),
            )
            .map_err(|_| "incident is not investigating")?;
        if !automatic && approved.as_deref() != Some(name) {
            return Err("approval required".into());
        }
        let count: u32 = tx
            .query_row(
                "SELECT count(*) FROM actions WHERE day=date('now')",
                [],
                |r| r.get(0),
            )
            .map_err(|_| "action storage unavailable")?;
        if count >= daily_limit {
            return Err("daily action limit reached".into());
        }
        tx.execute(
            "INSERT INTO actions VALUES(?,date('now'),?,'unknown')",
            params![id, name],
        )
        .map_err(|_| "action already attempted; operator reconciliation required")?;
        tx.execute(
            "UPDATE incidents SET approved_action=NULL,pending_action=NULL WHERE id=?",
            [id],
        )
        .map_err(|_| "action storage unavailable")?;
        tx.execute(
            "INSERT INTO audit(incident,kind,detail) VALUES(?,'action_claimed',?)",
            params![id, json!({"action":name}).to_string()],
        )
        .map_err(|_| "action storage unavailable")?;
        tx.commit().map_err(|_| "action storage unavailable".into())
    }

    pub fn action_outcome(&self, id: &str, outcome: &str) -> DbResult<()> {
        self.0.lock().unwrap().execute(
            "UPDATE actions SET outcome=? WHERE incident=?",
            params![outcome, id],
        )?;
        self.audit(id, "action_outcome", json!({"outcome":outcome}))
    }

    pub fn has_pending(&self, id: &str) -> DbResult<bool> {
        self.0.lock().unwrap().query_row(
            "SELECT pending_action IS NOT NULL FROM incidents WHERE id=?",
            [id],
            |r| r.get(0),
        )
    }

    pub fn resolve_observed_healthy(&self, monitor: &str, evidence: Value) -> DbResult<()> {
        let mut c = self.0.lock().unwrap();
        let tx = c.transaction()?;
        let id:Option<String>=tx.query_row("SELECT id FROM incidents WHERE monitor=? AND state IN ('needs_attention','awaiting_approval')",[monitor],|r|r.get(0)).optional()?;
        if let Some(id) = id {
            tx.execute(
                "INSERT INTO audit(incident,kind,detail) VALUES(?,'external_recovery_verified',?)",
                params![id, evidence.to_string()],
            )?;
            tx.execute("UPDATE incidents SET state='resolved',pending_action=NULL,approved_action=NULL WHERE id=?",[id])?;
        }
        tx.commit()
    }
}
