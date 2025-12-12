import { v4 as uuidv4 } from 'uuid';
import type { WebSocket as WSWebSocket } from 'ws';
import type {
  ConnectedClient,
  WSMessage,
  ConnectToMachinePayload,
  ConnectionRequestPayload,
  RTCOfferPayload,
  RTCAnswerPayload,
  RTCIceCandidatePayload,
} from './types.js';
import { canUserAccessMachine, getMachineById } from './machines.js';

// Track active connections between machines
interface PendingConnection {
  id: string;
  fromMachineId: string;
  toMachineId: string;
  fromClient: ConnectedClient;
  createdAt: Date;
}

const pendingConnections = new Map<string, PendingConnection>();

// Map machine IDs to their connected WebSocket clients
const machineClients = new Map<string, ConnectedClient>();

export function registerMachineClient(machineId: string, client: ConnectedClient) {
  machineClients.set(machineId, client);
}

export function unregisterMachineClient(machineId: string) {
  machineClients.delete(machineId);
}

export function getMachineClient(machineId: string): ConnectedClient | undefined {
  return machineClients.get(machineId);
}

export async function handleConnectToMachine(
  client: ConnectedClient,
  payload: ConnectToMachinePayload
): Promise<void> {
  const { targetMachineId } = payload;

  if (!client.userId || !client.machineId) {
    sendError(client.ws, 'NOT_AUTHENTICATED', 'Must be authenticated with a machine');
    return;
  }

  // Check if user can access the target machine
  const canAccess = await canUserAccessMachine(client.userId, targetMachineId);
  if (!canAccess) {
    sendError(client.ws, 'ACCESS_DENIED', 'You do not have access to this machine');
    return;
  }

  // Check if target machine is online
  const targetClient = machineClients.get(targetMachineId);
  if (!targetClient) {
    sendError(client.ws, 'MACHINE_OFFLINE', 'Target machine is not online');
    return;
  }

  // Get source machine info
  const sourceMachine = await getMachineById(client.machineId);
  if (!sourceMachine) {
    sendError(client.ws, 'MACHINE_NOT_FOUND', 'Source machine not found');
    return;
  }

  // Create pending connection
  const connectionId = uuidv4();
  const pending: PendingConnection = {
    id: connectionId,
    fromMachineId: client.machineId,
    toMachineId: targetMachineId,
    fromClient: client,
    createdAt: new Date(),
  };
  pendingConnections.set(connectionId, pending);

  // Send connection request to target machine
  const requestPayload: ConnectionRequestPayload = {
    fromMachineId: client.machineId,
    fromMachineName: sourceMachine.name,
    connectionId,
  };

  send(targetClient.ws, {
    type: 'connection_request',
    payload: requestPayload,
  });

  // Clean up pending connection after timeout (30 seconds)
  setTimeout(() => {
    if (pendingConnections.has(connectionId)) {
      pendingConnections.delete(connectionId);
      sendError(client.ws, 'CONNECTION_TIMEOUT', 'Connection request timed out');
    }
  }, 30000);
}

export function handleConnectionAccepted(
  client: ConnectedClient,
  connectionId: string
): void {
  const pending = pendingConnections.get(connectionId);
  if (!pending) {
    sendError(client.ws, 'CONNECTION_NOT_FOUND', 'Connection request not found or expired');
    return;
  }

  // Verify the accepting client is the target machine
  if (client.machineId !== pending.toMachineId) {
    sendError(client.ws, 'INVALID_CONNECTION', 'You are not the target of this connection');
    return;
  }

  // Notify the initiator that connection was accepted
  send(pending.fromClient.ws, {
    type: 'connection_accepted',
    payload: {
      connectionId,
      targetMachineId: pending.toMachineId,
    },
  });

  // Keep the pending connection for RTC signaling
  // It will be cleaned up when the connection is established or times out
}

export function handleConnectionRejected(
  client: ConnectedClient,
  connectionId: string,
  reason: string
): void {
  const pending = pendingConnections.get(connectionId);
  if (!pending) {
    return;
  }

  // Verify the rejecting client is the target machine
  if (client.machineId !== pending.toMachineId) {
    return;
  }

  // Notify the initiator
  send(pending.fromClient.ws, {
    type: 'connection_rejected',
    payload: {
      connectionId,
      reason,
    },
  });

  pendingConnections.delete(connectionId);
}

export function handleRTCOffer(
  client: ConnectedClient,
  payload: RTCOfferPayload
): void {
  const { connectionId, targetMachineId, sdp } = payload;

  const pending = pendingConnections.get(connectionId);
  if (!pending) {
    sendError(client.ws, 'CONNECTION_NOT_FOUND', 'Connection not found');
    return;
  }

  // Verify the client is part of this connection
  if (client.machineId !== pending.fromMachineId && client.machineId !== pending.toMachineId) {
    sendError(client.ws, 'INVALID_CONNECTION', 'You are not part of this connection');
    return;
  }

  // Forward offer to target
  const targetClient = machineClients.get(targetMachineId);
  if (!targetClient) {
    sendError(client.ws, 'MACHINE_OFFLINE', 'Target machine went offline');
    return;
  }

  send(targetClient.ws, {
    type: 'rtc_offer',
    payload: {
      connectionId,
      targetMachineId: client.machineId, // The sender becomes the target for the response
      sdp,
    },
  });
}

export function handleRTCAnswer(
  client: ConnectedClient,
  payload: RTCAnswerPayload
): void {
  const { connectionId, targetMachineId, sdp } = payload;

  const pending = pendingConnections.get(connectionId);
  if (!pending) {
    sendError(client.ws, 'CONNECTION_NOT_FOUND', 'Connection not found');
    return;
  }

  // Forward answer to target
  const targetClient = machineClients.get(targetMachineId);
  if (!targetClient) {
    sendError(client.ws, 'MACHINE_OFFLINE', 'Target machine went offline');
    return;
  }

  send(targetClient.ws, {
    type: 'rtc_answer',
    payload: {
      connectionId,
      targetMachineId: client.machineId,
      sdp,
    },
  });

  // Connection established, clean up pending
  pendingConnections.delete(connectionId);
}

export function handleRTCIceCandidate(
  client: ConnectedClient,
  payload: RTCIceCandidatePayload
): void {
  const { connectionId, targetMachineId, candidate, sdpMid, sdpMLineIndex } = payload;

  // Forward ICE candidate to target
  const targetClient = machineClients.get(targetMachineId);
  if (!targetClient) {
    // Target offline, ignore
    return;
  }

  send(targetClient.ws, {
    type: 'rtc_ice_candidate',
    payload: {
      connectionId,
      targetMachineId: client.machineId,
      candidate,
      sdpMid,
      sdpMLineIndex,
    },
  });
}

// Broadcast machine status change to relevant users
export async function broadcastMachineStatus(
  machineId: string,
  isOnline: boolean,
  excludeClient?: ConnectedClient
): Promise<void> {
  const machine = await getMachineById(machineId);
  if (!machine) return;

  // Find all connected clients for the same user
  for (const [_id, client] of machineClients) {
    if (client.userId === machine.userId && client !== excludeClient) {
      send(client.ws, {
        type: isOnline ? 'machine_online' : 'machine_offline',
        payload: {
          machineId,
          name: machine.name,
        },
      });
    }
  }
}

function send(ws: WSWebSocket, message: WSMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function sendError(ws: WSWebSocket, code: string, message: string): void {
  send(ws, {
    type: 'error',
    payload: { code, message },
  });
}
