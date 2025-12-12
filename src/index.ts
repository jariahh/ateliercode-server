import { config } from './config.js';
import { createWSServer } from './server.js';
import { pool } from './db/index.js';

async function main() {
  console.log('Starting AtelierCode Server...');

  // Test database connection
  try {
    await pool.query('SELECT 1');
    console.log('Database connection successful');
  } catch (error) {
    console.error('Database connection failed:', error);
    console.log('Server will start but database features will not work');
    console.log('Make sure PostgreSQL is running and DATABASE_URL is set correctly');
  }

  // Create and start WebSocket server
  const server = createWSServer();

  server.listen(config.port, config.host, () => {
    console.log(`Server listening on ws://${config.host}:${config.port}`);
    console.log(`Health check: http://${config.host}:${config.port}/health`);
  });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    server.close();
    await pool.end();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\nShutting down...');
    server.close();
    await pool.end();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
