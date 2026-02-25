// Shared types for AtelierCode server
import type { WebSocket as WSWebSocket } from 'ws';

export interface Machine {
  id: string;
  userId: string;
  name: string;
  platform: 'windows' | 'macos' | 'linux';
  lastSeen: Date;
  isOnline: boolean;
  capabilities: MachineCapabilities;
  createdAt: Date;
}

export interface MachineCapabilities {
  hasGit: boolean;
  hasNode: boolean;
  hasRust: boolean;
  hasPython: boolean;
}

// WebSocket Message Types
export type WSMessageType =
  | 'auth'
  | 'auth_response'
  | 'register_machine'
  | 'machine_registered'
  | 'heartbeat'
  | 'heartbeat_ack'
  | 'list_machines'
  | 'machines_list'
  | 'delete_machine'
  | 'delete_machine_response'
  | 'rename_machine'
  | 'rename_machine_response'
  | 'connect_to_machine'
  | 'connection_request'
  | 'connection_accepted'
  | 'connection_rejected'
  | 'rtc_offer'
  | 'rtc_answer'
  | 'rtc_ice_candidate'
  | 'machine_online'
  | 'machine_offline'
  | 'error';

export interface WSMessage<T = unknown> {
  type: WSMessageType;
  id?: string; // For request/response correlation
  payload: T;
}

// Auth messages — only token-based (Keycloak handles login/registration)
export interface AuthPayload {
  token: string;
}

export interface AuthResponse {
  success: boolean;
  user?: {
    id: string;
    email: string;
    username: string;
    roles: string[];
  };
  error?: string;
}

// Machine registration
export interface RegisterMachinePayload {
  name: string;
  platform: Machine['platform'];
  capabilities: MachineCapabilities;
}

export interface MachineRegisteredPayload {
  machineId: string;
  name: string;
}

// Machine listing
export interface MachineInfo {
  id: string;
  name: string;
  platform: Machine['platform'];
  isOnline: boolean;
  lastSeen: Date;
  isOwn: boolean; // true if this is the user's own machine
}

export interface MachinesListPayload {
  machines: MachineInfo[];
}

// WebRTC signaling
export interface ConnectToMachinePayload {
  targetMachineId: string;
}

export interface ConnectionRequestPayload {
  fromMachineId: string;
  fromMachineName: string;
  connectionId: string;
}

export interface ConnectionAcceptedPayload {
  connectionId: string;
  targetMachineId: string;
}

export interface ConnectionRejectedPayload {
  connectionId: string;
  reason: string;
}

export interface RTCOfferPayload {
  connectionId: string;
  targetMachineId: string;
  sdp: string;
}

export interface RTCAnswerPayload {
  connectionId: string;
  targetMachineId: string;
  sdp: string;
}

export interface RTCIceCandidatePayload {
  connectionId: string;
  targetMachineId: string;
  candidate: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
}

// Error
export interface ErrorPayload {
  code: string;
  message: string;
}

// Connected client state - uses ws library WebSocket type
export interface ConnectedClient {
  ws: WSWebSocket;
  userId?: string;
  machineId?: string;
  authenticated: boolean;
  lastHeartbeat: Date;
}
