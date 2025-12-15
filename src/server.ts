import { WebSocketServer, WebSocket as WSWebSocket } from 'ws';
import { createServer } from 'http';
import { config } from './config.js';
import { verifyToken, loginUser, registerUser, getUserById } from './auth.js';
import {
  registerMachine,
  updateMachineOnlineStatus,
  updateMachineHeartbeat,
  getMachinesForUser,
  markStaleOffline,
  deleteMachine,
  renameMachine,
} from './machines.js';
import {
  registerMachineClient,
  unregisterMachineClient,
  handleConnectToMachine,
  handleConnectionAccepted,
  handleConnectionRejected,
  handleRTCOffer,
  handleRTCAnswer,
  handleRTCIceCandidate,
  broadcastMachineStatus,
} from './signaling.js';
import type {
  ConnectedClient,
  WSMessage,
  AuthPayload,
  RegisterUserPayload,
  RegisterMachinePayload,
  ConnectToMachinePayload,
  RTCOfferPayload,
  RTCAnswerPayload,
  RTCIceCandidatePayload,
} from './types.js';

const clients = new Map<WSWebSocket, ConnectedClient>();

// Helper to read request body
function readBody(req: import('http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export function createWSServer() {
  const server = createServer(async (req, res) => {
    // CORS headers for HTTP endpoints
    const origin = req.headers.origin || '';
    if (config.cors.allowedOrigins.includes(origin) || config.cors.allowedOrigins.includes('*')) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }

    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Simple health check endpoint
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', clients: clients.size }));
      return;
    }

    // ICE servers endpoint - returns STUN/TURN configuration for WebRTC
    if (req.url === '/ice-servers') {
      const iceServers = [
        // STUN servers
        ...config.ice.stunServers.map((url) => ({ urls: url })),
        // TURN servers (only include if credential is configured)
        ...config.ice.turnServers
          .filter((t) => t.credential)
          .map((t) => ({
            urls: t.urls,
            username: t.username,
            credential: t.credential,
          })),
      ];

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ iceServers }));
      return;
    }

    // HTTP Auth endpoints for web app
    if (req.url === '/auth/login' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const { email, password } = JSON.parse(body);

        if (!email || !password) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Email and password required' }));
          return;
        }

        const result = await loginUser(email, password);

        if (result.success) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        }
      } catch (error) {
        console.error('Login endpoint error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Internal server error' }));
      }
      return;
    }

    if (req.url === '/auth/register' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const { email, username, password } = JSON.parse(body);

        if (!email || !username || !password) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Email, username, and password required' }));
          return;
        }

        const result = await registerUser(email, username, password);

        if (result.success) {
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        }
      } catch (error) {
        console.error('Register endpoint error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Internal server error' }));
      }
      return;
    }

    if (req.url === '/auth/me' && req.method === 'GET') {
      try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No token provided' }));
          return;
        }

        const token = authHeader.slice(7);
        const decoded = verifyToken(token);

        if (!decoded) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid or expired token' }));
          return;
        }

        const user = await getUserById(decoded.userId);
        if (!user) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'User not found' }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(user));
      } catch (error) {
        console.error('Auth me endpoint error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    console.log('New WebSocket connection');

    const client: ConnectedClient = {
      ws,
      authenticated: false,
      lastHeartbeat: new Date(),
    };
    clients.set(ws, client);

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString()) as WSMessage;
        await handleMessage(client, message);
      } catch (error) {
        console.error('Error handling message:', error);
        sendError(ws, 'INVALID_MESSAGE', 'Invalid message format');
      }
    });

    ws.on('close', async () => {
      console.log('WebSocket connection closed');
      await handleDisconnect(client);
      clients.delete(ws);
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });
  });

  // Periodic heartbeat check and stale machine cleanup
  setInterval(async () => {
    const now = Date.now();

    // Check for stale clients
    for (const [ws, client] of clients) {
      const elapsed = now - client.lastHeartbeat.getTime();
      if (elapsed > config.heartbeatTimeout) {
        console.log('Closing stale connection');
        ws.close();
      }
    }

    // Mark stale machines as offline in database
    const staleMachines = await markStaleOffline(config.heartbeatTimeout);
    for (const machineId of staleMachines) {
      await broadcastMachineStatus(machineId, false);
    }
  }, config.heartbeatInterval);

  return server;
}

async function handleMessage(client: ConnectedClient, message: WSMessage): Promise<void> {
  const { type, id, payload } = message;

  switch (type) {
    case 'auth': {
      const authPayload = payload as AuthPayload;
      await handleAuth(client, authPayload, id);
      break;
    }

    case 'register_user': {
      const regUserPayload = payload as RegisterUserPayload;
      await handleRegisterUser(client, regUserPayload, id);
      break;
    }

    case 'register_machine': {
      if (!client.authenticated) {
        sendError(client.ws, 'NOT_AUTHENTICATED', 'Must authenticate first');
        return;
      }
      const regPayload = payload as RegisterMachinePayload;
      await handleRegisterMachine(client, regPayload, id);
      break;
    }

    case 'heartbeat': {
      client.lastHeartbeat = new Date();
      if (client.machineId) {
        await updateMachineHeartbeat(client.machineId);
      }
      send(client.ws, { type: 'heartbeat_ack', payload: {} });
      break;
    }

    case 'list_machines': {
      if (!client.authenticated || !client.userId) {
        sendError(client.ws, 'NOT_AUTHENTICATED', 'Must authenticate first');
        return;
      }
      const machines = await getMachinesForUser(client.userId);
      send(client.ws, {
        type: 'machines_list',
        id,
        payload: { machines },
      });
      break;
    }

    case 'delete_machine': {
      if (!client.authenticated || !client.userId) {
        sendError(client.ws, 'NOT_AUTHENTICATED', 'Must authenticate first');
        return;
      }
      const { machineId: deleteMachineId } = payload as { machineId: string };
      const deleted = await deleteMachine(client.userId, deleteMachineId);
      send(client.ws, {
        type: 'delete_machine_response',
        id,
        payload: { success: deleted, machineId: deleteMachineId },
      });
      break;
    }

    case 'rename_machine': {
      if (!client.authenticated || !client.userId) {
        sendError(client.ws, 'NOT_AUTHENTICATED', 'Must authenticate first');
        return;
      }
      const { machineId: renameMachineId, newName } = payload as { machineId: string; newName: string };
      const renamed = await renameMachine(client.userId, renameMachineId, newName);
      send(client.ws, {
        type: 'rename_machine_response',
        id,
        payload: { success: renamed, machineId: renameMachineId, newName },
      });
      break;
    }

    case 'connect_to_machine': {
      if (!client.authenticated) {
        sendError(client.ws, 'NOT_AUTHENTICATED', 'Must authenticate first');
        return;
      }
      await handleConnectToMachine(client, payload as ConnectToMachinePayload);
      break;
    }

    case 'connection_accepted': {
      handleConnectionAccepted(client, (payload as { connectionId: string }).connectionId);
      break;
    }

    case 'connection_rejected': {
      const { connectionId, reason } = payload as { connectionId: string; reason: string };
      handleConnectionRejected(client, connectionId, reason);
      break;
    }

    case 'rtc_offer': {
      handleRTCOffer(client, payload as RTCOfferPayload);
      break;
    }

    case 'rtc_answer': {
      handleRTCAnswer(client, payload as RTCAnswerPayload);
      break;
    }

    case 'rtc_ice_candidate': {
      handleRTCIceCandidate(client, payload as RTCIceCandidatePayload);
      break;
    }

    default:
      sendError(client.ws, 'UNKNOWN_MESSAGE', `Unknown message type: ${type}`);
  }
}

async function handleAuth(
  client: ConnectedClient,
  payload: AuthPayload,
  messageId?: string
): Promise<void> {
  let response;

  if (payload.token) {
    // Authenticate with existing token
    const decoded = verifyToken(payload.token);
    if (!decoded) {
      response = { success: false, error: 'Invalid or expired token' };
    } else {
      const user = await getUserById(decoded.userId);
      if (!user) {
        response = { success: false, error: 'User not found' };
      } else {
        client.authenticated = true;
        client.userId = user.id;
        response = { success: true, user };
      }
    }
  } else if (payload.email && payload.password) {
    // Login with credentials
    response = await loginUser(payload.email, payload.password);
    if (response.success && response.user) {
      client.authenticated = true;
      client.userId = response.user.id;
    }
  } else {
    response = { success: false, error: 'Must provide token or email/password' };
  }

  send(client.ws, {
    type: 'auth_response',
    id: messageId,
    payload: response,
  });
}

async function handleRegisterUser(
  client: ConnectedClient,
  payload: RegisterUserPayload,
  messageId?: string
): Promise<void> {
  const response = await registerUser(payload.email, payload.username, payload.password);

  if (response.success && response.user) {
    client.authenticated = true;
    client.userId = response.user.id;
  }

  send(client.ws, {
    type: 'register_user_response',
    id: messageId,
    payload: response,
  });
}

async function handleRegisterMachine(
  client: ConnectedClient,
  payload: RegisterMachinePayload,
  messageId?: string
): Promise<void> {
  if (!client.userId) {
    sendError(client.ws, 'NOT_AUTHENTICATED', 'Must authenticate first');
    return;
  }

  try {
    const machine = await registerMachine(
      client.userId,
      payload.name,
      payload.platform,
      payload.capabilities
    );

    client.machineId = machine.id;
    registerMachineClient(machine.id, client);

    // Broadcast to other clients of this user
    await broadcastMachineStatus(machine.id, true, client);

    send(client.ws, {
      type: 'machine_registered',
      id: messageId,
      payload: {
        machineId: machine.id,
        name: machine.name,
      },
    });
  } catch (error) {
    console.error('Error registering machine:', error);
    sendError(client.ws, 'REGISTRATION_FAILED', 'Failed to register machine');
  }
}

async function handleDisconnect(client: ConnectedClient): Promise<void> {
  if (client.machineId) {
    unregisterMachineClient(client.machineId);
    await updateMachineOnlineStatus(client.machineId, false);
    await broadcastMachineStatus(client.machineId, false);
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
