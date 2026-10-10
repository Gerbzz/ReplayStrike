use serde::de::DeserializeOwned;
use serde_json::{Map, Value};
use std::path::PathBuf;
use std::sync::Mutex;

/// Small JSON-file store: one object per file, written on every change.
pub struct Store {
    path: PathBuf,
    data: Mutex<Map<String, Value>>,
}

impl Store {
    pub fn open(path: PathBuf) -> Self {
        let data = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Map<String, Value>>(&s).ok())
            .unwrap_or_default();
        Self { path, data: Mutex::new(data) }
    }

    pub fn get(&self, key: &str) -> Value {
        self.data.lock().unwrap().get(key).cloned().unwrap_or(Value::Null)
    }

    pub fn get_as<T: DeserializeOwned + Default>(&self, key: &str) -> T {
        serde_json::from_value(self.get(key)).unwrap_or_default()
    }

    pub fn set(&self, key: &str, value: Value) {
        let mut data = self.data.lock().unwrap();
        data.insert(key.to_string(), value);
        self.write(&data);
    }

    /// Edits the object stored under `key` (created if missing) in place.
    pub fn update_map(&self, key: &str, f: impl FnOnce(&mut Map<String, Value>)) {
        let mut data = self.data.lock().unwrap();
        let entry = data.entry(key.to_string()).or_insert_with(|| Value::Object(Map::new()));
        if !entry.is_object() {
            *entry = Value::Object(Map::new());
        }
        f(entry.as_object_mut().unwrap());
        self.write(&data);
    }

    fn write(&self, data: &Map<String, Value>) {
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(text) = serde_json::to_string_pretty(data) {
            let _ = std::fs::write(&self.path, text);
        }
    }
}
