import 'dotenv/config';

export const config = {
  port: parseInt(process.env.PORT || '8080', 10),
  host: process.env.HOST || '0.0.0.0',

  database: {
    url: process.env.DATABASE_URL || 'postgresql://localhost:5432/ateliercode',
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'development-secret-change-in-production',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  cors: {
    allowedOrigins: (process.env.ALLOWED_ORIGINS || 'http://localhost:1420').split(','),
  },

  // Heartbeat interval in ms - machines must ping within this time to stay online
  heartbeatInterval: 30000,
  heartbeatTimeout: 90000, // Mark offline after this time without heartbeat

  // ICE servers for WebRTC (STUN/TURN)
  // Uses existing COTURN server from rcms infrastructure
  ice: {
    stunServers: (process.env.STUN_SERVERS || 'stun:app.rcmedicalspecialist.com:3478,stun:stun.l.google.com:19302').split(','),
    turnServers: [
      {
        urls: process.env.TURN_URL || 'turn:app.rcmedicalspecialist.com:3478',
        username: process.env.TURN_USERNAME || 'rcms',
        credential: process.env.TURN_CREDENTIAL || '',
      },
      {
        urls: process.env.TURN_TCP_URL || 'turn:app.rcmedicalspecialist.com:3478?transport=tcp',
        username: process.env.TURN_USERNAME || 'rcms',
        credential: process.env.TURN_CREDENTIAL || '',
      },
      {
        urls: process.env.TURNS_URL || 'turns:app.rcmedicalspecialist.com:443',
        username: process.env.TURN_USERNAME || 'rcms',
        credential: process.env.TURN_CREDENTIAL || '',
      },
    ],
  },
};
