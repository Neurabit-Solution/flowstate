import { Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron';
import type { AppStatus, DevState, Override } from '../shared/types';

export const STATE_LABEL: Record<DevState, string> = {
  off: 'Off',
  warming_up: 'Warming up',
  away: 'Away',
  talking: 'In a conversation',
  available: 'Available',
  focused: 'Focus',
};

const COLOR: Record<DevState, [number, number, number]> = {
  off: [120, 126, 140],
  warming_up: [200, 170, 70],
  away: [120, 126, 140],
  talking: [90, 150, 230],
  available: [90, 200, 130],
  focused: [150, 110, 240],
};
const CAMERA_RING: [number, number, number] = [230, 50, 45];

/** Drawn in code. A red ring means the camera is on, whatever the state. */
function icon(state: DevState, cameraOn: boolean) {
  const size = 22;
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const [r, g, b] = COLOR[state];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const d = Math.hypot(x - c, y - c);
      const i = (y * size + x) * 4;
      let px: [number, number, number] | null = null;
      if (d <= 6) px = [r, g, b];
      else if (cameraOn && d >= 8 && d <= 10.5) px = CAMERA_RING;
      if (px) {
        // Bitmaps are BGRA.
        buf[i] = px[2];
        buf[i + 1] = px[1];
        buf[i + 2] = px[0];
        buf[i + 3] = 255;
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

export type TrayActions = {
  startCamera(): void;
  stopCamera(): void;
  setOverride(override: Override | null, forMinutes?: number): void;
  stopUntilClicked(): void;
  openWindow(): void;
  quit(): void;
};

export class AppTray {
  private readonly tray: Tray;

  constructor(private readonly actions: TrayActions) {
    this.tray = new Tray(icon('off', false));
    this.tray.on('click', () => actions.openWindow());
  }

  update(status: AppStatus): void {
    const { actions } = this;
    const sample = status.source === 'replay';
    const stateText = `${sample ? 'Sample recording (not live): ' : ''}${STATE_LABEL[status.state]}`;
    const camera = status.cameraOn ? 'Camera on' : 'Camera off';
    this.tray.setImage(icon(status.state, status.cameraOn));
    this.tray.setToolTip(`FlowState: ${stateText}. ${camera}.`);

    const sensing = status.source === 'live';
    const items: MenuItemConstructorOptions[] = [
      { label: stateText, enabled: false },
      { label: camera, enabled: false },
      { label: `SDK minutes today: ${status.sdkMinutesToday}${status.overDailyCap ? ' (over your daily limit)' : ''}`, enabled: false },
      { type: 'separator' },
      sensing
        ? { label: 'Stop camera', click: () => actions.stopCamera() }
        : { label: 'Turn on camera', enabled: !sample, click: () => actions.startCamera() },
      { type: 'separator' },
      { label: "I'm focusing", type: 'radio', checked: status.override === 'focus', click: () => actions.setOverride('focus') },
      { label: "I'm free", type: 'radio', checked: status.override === 'free', click: () => actions.setOverride('free') },
      { label: 'Automatic', type: 'radio', checked: status.override !== 'focus' && status.override !== 'free', click: () => actions.setOverride(null) },
      { type: 'separator' },
      {
        label: 'Pause sensing',
        enabled: sensing || status.override === 'paused',
        submenu: [
          { label: '15 minutes', click: () => actions.setOverride('paused', 15) },
          { label: '1 hour', click: () => actions.setOverride('paused', 60) },
          { label: 'Until tomorrow (turn it back on yourself)', click: () => actions.stopUntilClicked() },
        ],
      },
      { type: 'separator' },
      { label: 'Open FlowState', click: () => actions.openWindow() },
      { label: 'Quit', click: () => actions.quit() },
    ];
    this.tray.setContextMenu(Menu.buildFromTemplate(items));
  }
}
