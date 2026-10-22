
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

// 官方预设颜色（CXCY 打包值）
const COLORS: Record<string, number> = {
  藤萝紫: 207948282, 山海青: 214175122, 竹影绿: 242749551, 胡杨黄: 301010749,
  桃林红: 299502821, 星云: 162793604, 梦幻: 136054106, 火烧云: 324275309,
  加州阳光: 288098833, 晚霞: 211158890,
};

const DAYLIGHT: Record<string, number> = {
  晨曦: 196672844, 旭日: 262209228, 沐阳: 327745279, 夕照: 177011814, 明月: 655424537, 静夜: 118029324,
};

const SCENES = ['流水', '跑马', '呼吸', '律动', '静态色温渐变', '动态色温渐变', '静态颜色渐变'];

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j;
}

export default function IndexPage() {
  const [homes, setHomes] = useState<Home[]>([]);
  const [activeHome, setActiveHome] = useState<string | null>(null);
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 控制面板状态
  const [bright, setBright] = useState(80);
  const [cct, setCct] = useState(4000);
  const [duv, setDuv] = useState(0);
  const [scene, setScene] = useState('跑马');
  const [sceneSpeed, setSceneSpeed] = useState(50);
  const [sceneColor, setSceneColor] = useState('晚霞');
  const [sceneDir, setSceneDir] = useState('forward');
  const [gradualDuration, setGradualDuration] = useState(5);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await api('/tree');
      setHomes(data);
      if (!activeHome && data.length) { const first = data.find(h => (h.deviceCount ?? 0) > 0) ?? data[0]; setActiveHome(first.projectCode); }
    } catch (e: any) {
      setError(e.message);
    }
  }, [activeHome]);

  useEffect(() => { load(); }, []);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2000);
  };

  const send = async (path: string, body: any, okMsg: string) => {
    if (!selectedDevice) return;
    setBusy(true);
    try {
      await api(path, { method: 'POST', body: JSON.stringify({ vDeviceId: selectedDevice.vDeviceId, ...body }) });
      flash(okMsg);
    } catch (e: any) {
      flash(`失败: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const home = homes.find((h) => h.projectCode === activeHome);
  const isLight = selectedDevice && /灯|Light|带/i.test(`${selectedDevice.name}${selectedDevice.type ?? ''}`);

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
              onClick={() => { setActiveHome(h.projectCode); setSelectedDevice(null); }}
            >
              🏠 {h.name}
              <span className={styles.tabCount}>
                {h.onlineCount != null ? `${h.onlineCount}/${h.deviceCount}` : h.deviceCount}
              </span>
            </button>
          ))}
          <button type="button" className={styles.refresh} onClick={load}>⟳ 刷新</button>
        </nav>
      </header>

      {error && <div className={styles.error}>{error}（token 可能失效，请重新抓包更新）</div>}
      {toast && <div className={styles.toast}>{toast}</div>}

      <main className={styles.layout}>
        <section className={styles.rooms}>
          {home?.rooms.map((room) => (
            <div key={room.gpno} className={styles.room}>
              <h2>🛏 {room.name} <span className={styles.roomCount}>{room.devices.length} 台</span></h2>
              <div className={styles.devices}>
                {room.devices.map((d) => (
                  <button
                    key={d.vDeviceId}
                    type="button"
                    className={`${styles.device} ${d.vDeviceId === selectedDevice?.vDeviceId ? styles.deviceActive : ''} ${d.online ? '' : styles.deviceOffline}`}
                    onClick={() => setSelectedDevice(d)}
                  >
                    <span className={styles.dot}>{d.online ? '●' : '○'}</span>
                    <span className={styles.deviceName}>{d.name}</span>
                    <span className={styles.deviceType}>{d.protocol}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
          {home && !home.rooms.length && <p className={styles.empty}>该家庭暂无房间</p>}
        </section>

        {selectedDevice && (
          <aside className={styles.panel}>
            <h2>
              {selectedDevice.online ? '●' : '○'} {selectedDevice.name}
              <span className={styles.panelId}>[{selectedDevice.vDeviceId}]</span>
            </h2>
            <p className={styles.panelMeta}>{selectedDevice.type} · {selectedDevice.protocol}
              {selectedDevice.parent ? ` · 网关 ${selectedDevice.parent}` : ''}</p>

            <div className={styles.ctrlRow}>
              <button type="button" disabled={busy} className={styles.btnPrimary}
                onClick={() => send('/light', { op: 'on' }, '已开灯')}>开灯</button>
              <button type="button" disabled={busy} className={styles.btnDanger}
                onClick={() => send('/light', { op: 'off' }, '已关灯')}>关灯</button>
            </div>

            {isLight && (
              <>
                <div className={styles.ctrlBlock}>
                  <label>亮度 <b>{bright}%</b></label>
                  <input type="range" min={1} max={100} value={bright}
                    onChange={(e) => setBright(Number(e.target.value))} />
                  <button type="button" disabled={busy}
                    onClick={() => send('/light', { op: 'bright', value: `${bright}%` }, `亮度 ${bright}%`)}>应用</button>
                </div>

                <div className={styles.ctrlBlock}>
                  <label>色温 <b>{cct}K</b></label>
                  <input type="range" min={1800} max={12000} step={50} value={cct}
                    onChange={(e) => setCct(Number(e.target.value))} />
                  <button type="button" disabled={busy}
                    onClick={() => send('/light', { op: 'cct', value: cct }, `色温 ${cct}K`)}>应用</button>
                </div>

                <div className={styles.ctrlBlock}>
                  <label>DUV <b>{duv > 0 ? `+${duv}` : duv}</b>（日光偏移）</label>
                  <input type="range" min={-8} max={8} value={duv}
                    onChange={(e) => setDuv(Number(e.target.value))} />
                  <button type="button" disabled={busy}
                    onClick={() => send('/light', { op: 'duv', value: duv }, `DUV ${duv}`)}>应用</button>
                </div>

                <div className={styles.ctrlBlock}>
                  <label>颜色（预设）</label>
                  <div className={styles.colorGrid}>
                    {Object.keys(COLORS).map((name) => (
                      <button key={name} type="button" disabled={busy} className={styles.colorBtn}
                        onClick={() => send('/light', { op: 'color', value: COLORS[name] }, `颜色 ${name}`)}>
                        {name}
                      </button>
                    ))}
                  </div>
                </div>

                <div className={styles.ctrlBlock}>
                  <label>日光模式</label>
                  <div className={styles.colorGrid}>
                    {Object.keys(DAYLIGHT).map((name) => (
                      <button key={name} type="button" disabled={busy} className={styles.colorBtn}
                        onClick={() => send('/light', { op: 'daylight', value: DAYLIGHT[name] }, name)}>
                        {name}
                      </button>
                    ))}
                  </div>
                </div>

                <div className={styles.ctrlBlock}>
                  <label>灯效（悦动模式）</label>
                  <div className={styles.sceneGrid}>
                    {SCENES.map((s) => (
                      <button key={s} type="button" disabled={busy}
                        className={`${styles.sceneBtn} ${s === scene ? styles.sceneActive : ''}`}
                        onClick={() => setScene(s)}>{s}</button>
                    ))}
                  </div>

                  <div className={styles.sceneOpts}>
                    <label>颜色
                      <select value={sceneColor} onChange={(e) => setSceneColor(e.target.value)}>
                        {Object.keys(COLORS).map((n) => <option key={n} value={n}>{n}</option>)}
                      </select>
                    </label>
                    <label>速度
                      <input type="range" min={1} max={100} value={sceneSpeed}
                        onChange={(e) => setSceneSpeed(Number(e.target.value))} />
                      <b>{sceneSpeed}</b>
                    </label>
                    <label>方向
                      <select value={sceneDir} onChange={(e) => setSceneDir(e.target.value)}>
                        <option value="forward">正向</option>
                        <option value="reverse">逆向</option>
                      </select>
                    </label>
                    {(scene.includes('渐变')) && (
                      <label>时长
                        <input type="range" min={1} max={10} value={gradualDuration}
                          onChange={(e) => setGradualDuration(Number(e.target.value))} />
                        <b>{gradualDuration}</b>
                      </label>
                    )}
                    <button type="button" disabled={busy} className={styles.btnPrimary}
                      onClick={() => send('/scene', {
                        effect: scene,
                        opts: { color: COLORS[sceneColor], speed: sceneSpeed, direction: sceneDir, duration: gradualDuration },
                      }, `灯效 ${scene}`)}>执行灯效</button>
                  </div>
                </div>
              </>
            )}
          </aside>
        )}
      </main>
    </div>
  );
}
