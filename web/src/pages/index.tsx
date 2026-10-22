export const pageConfig = () => ({
  title: '欧享家 · 本地控制台',
});
import { useEffect, useState, useCallback } from 'react';
import styles from './index.module.css';

interface Device {
  vDeviceId: string;
  name: string;
  type: string | null;
  protocol: string | null;
  online: boolean;
  parent: string | null;
}

interface Room {
  gpno: number;
  name: string;
  deviceCount: number | null;
  devices: Device[];
}

interface Home {
  projectCode: string;
  name: string;
  deviceCount: number;
  onlineCount: number | null;
  rooms: Room[];
}

const API = '/api';

async function api(path: string) {
  const res = await fetch(`${API}${path}`);
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j;
}

export default function IndexPage() {
  const [homes, setHomes] = useState<Home[]>([]);
  const [activeHome, setActiveHome] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setError(null);
      const data = await api('/tree');
      setHomes(data);
      if (!activeHome && data.length) {
        const first = data.find((h) => (h.deviceCount ?? 0) > 0) ?? data[0];
        setActiveHome(first.projectCode);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [activeHome]);

  useEffect(() => { load(); }, []);

  const home = homes.find((h) => h.projectCode === activeHome);

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <h1>欧享家 · 本地控制台</h1>
        <nav className={styles.tabs}>
          {homes.map((h) => (
            <button
              key={h.projectCode}
              type="button"
              className={`${styles.tab} ${h.projectCode === activeHome ? styles.tabActive : ''}`}
              onClick={() => setActiveHome(h.projectCode)}
            >
              🏠 {h.name}
              <span className={styles.tabCount}>
                {h.onlineCount != null ? `${h.onlineCount}/${h.deviceCount}` : h.deviceCount}
              </span>
            </button>
          ))}
          <button type="button" className={styles.refresh} onClick={load} disabled={loading}>
            {loading ? '加载中…' : '⟳ 刷新'}
          </button>
        </nav>
      </header>

      {error && <div className={styles.error}>{error}（token 可能失效，请重新抓包更新）</div>}

      <main className={styles.rooms}>
        {home?.rooms.map((room) => (
          <div key={room.gpno} className={styles.room}>
            <h2>🛏 {room.name} <span className={styles.roomCount}>{room.devices.length} 台</span></h2>
            <div className={styles.devices}>
              {room.devices.map((d) => (
                <div
                  key={d.vDeviceId}
                  className={`${styles.device} ${d.online ? '' : styles.deviceOffline}`}
                >
                  <span className={styles.dot}>{d.online ? '●' : '○'}</span>
                  <span className={styles.deviceName}>{d.name}</span>
                  <span className={styles.deviceType}>{d.protocol}{d.parent ? ' · 网关子设备' : ''}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
        {home && !home.rooms.length && <p className={styles.empty}>该家庭暂无房间</p>}
      </main>
    </div>
  );
}
