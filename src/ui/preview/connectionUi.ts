import { Car, Droplet, Plane, Ship, TrainFront, Zap, type LucideIcon } from 'lucide-react';
import type { OutsideConnection } from '../../core/types';

/** Label, icon and colour per outside connection kind (shared by the quick preview and the game view). */
export const CONNECTION_UI: Record<OutsideConnection['kind'], { label: string; icon: LucideIcon; color: string }> = {
  road: { label: 'Road', icon: Car, color: '#e6edf3' },
  rail: { label: 'Rail', icon: TrainFront, color: '#c9a27a' },
  ship: { label: 'Ship', icon: Ship, color: '#6fb3e8' },
  air: { label: 'Air', icon: Plane, color: '#b7a2ee' },
  power: { label: 'Power', icon: Zap, color: '#f2d25c' },
  water: { label: 'Water', icon: Droplet, color: '#5fd0d8' },
};
