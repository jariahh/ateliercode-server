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

// Track active connections between machines/clients
interface PendingConnection {
  id: string;
  fromMachineId: string | null; // null for web clients
  fromClientId: string; // unique client ID for web clients
  toMachineId: string;
  fromClient: ConnectedClient;
  createdAt: Date;
}

const pendingConnections = new Map<string, PendingConnection>();

// Map machine IDs to their connected WebSocket clients
const machineClients = new Map<string, ConnectedClient>();

// Map client IDs to their connected WebSocket clients (for web clients without machines)
const webClients = new Map<string, ConnectedClient>();
let webClientCounter = 0;

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

  // Must be authenticated (but machineId is optional for web clients)
  if (!client.userId) {
    sendError(client.ws, 'NOT_AUTHENTICATED', 'Must be authenticated');
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

  // Generate a client ID for web clients that don't have a machineId
  let clientId = client.machineId;
  if (!clientId) {
    clientId = `web-client-${++webClientCounter}`;
    webClients.set(clientId, client);
  }

  // Get source name (machine name or "Web Client")
  let sourceName = 'Web Client';
  if (client.machineId) {
    const sourceMachine = await getMachineById(client.machineId);
    if (sourceMachine) {
      sourceName = sourceMachine.name;
    }
  }

  // Create pending connection
  const connectionId = uuidv4();
  const pending: PendingConnection = {
    id: connectionId,
    fromMachineId: client.machineId ?? null,
    fromClientId: clientId,
    toMachineId: targetMachineId,
    fromClient: client,
    createdAt: new Date(),
  };
  pendingConnections.set(connectionId, pending);

  // Send connection request to target machine
  const requestPayload: ConnectionRequestPayload = {
    fromMachineId: clientId, // Use clientId which works for both machine and web clients
    fromMachineName: sourceName,
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
      // Clean up web client tracking
      if (!client.machineId && clientId) {
        webClients.delete(clientId);
      }
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

// Helper to get client by ID (either machine or web client)
function getClientById(clientId: string): ConnectedClient | undefined {
  return machineClients.get(clientId) || webClients.get(clientId);
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

  // Verify the client is part of this connection (check both machineId and clientId)
  const clientIdentifier = client.machineId || pending.fromClientId;
  const isFromClient = pending.fromClient === client || clientIdentifier === pending.fromClientId;
  const isToClient = client.machineId === pending.toMachineId;

  if (!isFromClient && !isToClient) {
    sendError(client.ws, 'INVALID_CONNECTION', 'You are not part of this connection');
    return;
  }

  // Forward offer to target
  const targetClient = machineClients.get(targetMachineId);
  if (!targetClient) {
    sendError(client.ws, 'MACHINE_OFFLINE', 'Target machine went offline');
    return;
  }

  // Use clientId for web clients, machineId for machine clients
  const senderClientId = client.machineId || pending.fromClientId;

  send(targetClient.ws, {
    type: 'rtc_offer',
    payload: {
      connectionId,
      targetMachineId: senderClientId, // The sender becomes the target for the response
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

  // Forward answer to target (could be machine or web client)
  const targetClient = getClientById(targetMachineId);
  if (!targetClient) {
    sendError(client.ws, 'MACHINE_OFFLINE', 'Target went offline');
    return;
  }

  send(targetClient.ws, {
    type: 'rtc_answer',
    payload: {
      connectionId,
      targetMachineId: client.machineId || pending.toMachineId,
      sdp,
    },
  });

  // Connection established, clean up pending and web client tracking
  if (pending.fromClientId && !pending.fromMachineId) {
    webClients.delete(pending.fromClientId);
  }
  pendingConnections.delete(connectionId);
}

export function handleRTCIceCandidate(
  client: ConnectedClient,
  payload: RTCIceCandidatePayload
): void {
  const { connectionId, targetMachineId, candidate, sdpMid, sdpMLineIndex } = payload;

  // Forward ICE candidate to target (could be machine or web client)
  const targetClient = getClientById(targetMachineId);
  if (!targetClient) {
    // Target offline, ignore
    return;
  }

  // Get sender's client ID from pending connection if they're a web client
  const pending = pendingConnections.get(connectionId);
  const senderClientId = client.machineId || (pending?.fromClientId);

  send(targetClient.ws, {
    type: 'rtc_ice_candidate',
    payload: {
      connectionId,
      targetMachineId: senderClientId,
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
