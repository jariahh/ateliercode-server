import jwt, { SignOptions } from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { query } from './db/index.js';
import { config } from './config.js';
import type { DBUser, AuthResponse } from './types.js';

interface JWTPayload {
  userId: string;
  email: string;
}

export async function registerUser(
  email: string,
  username: string,
  password: string
): Promise<AuthResponse> {
  try {
    // Check if user already exists
    const existing = await query<DBUser>(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );

    if (existing.rows.length > 0) {
      return { success: false, error: 'Email already registered' };
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Create user
    const result = await query<DBUser>(
      `INSERT INTO users (email, username, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, email, username, created_at, updated_at`,
      [email, username, passwordHash]
    );

    const user = result.rows[0];

    // Generate JWT
    const token = generateToken(user.id, user.email);

    return {
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        createdAt: user.created_at,
        updatedAt: user.updated_at,
      },
    };
  } catch (error) {
    console.error('Registration error:', error);
    return { success: false, error: 'Registration failed' };
  }
}

export async function loginUser(
  email: string,
  password: string
): Promise<AuthResponse> {
  try {
    // Find user
    const result = await query<DBUser>(
      `SELECT id, email, username, password_hash, created_at, updated_at
       FROM users WHERE email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      return { success: false, error: 'Invalid credentials' };
    }

    const user = result.rows[0];

    // Verify password
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return { success: false, error: 'Invalid credentials' };
    }

    // Generate JWT
    const token = generateToken(user.id, user.email);

    return {
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        createdAt: user.created_at,
        updatedAt: user.updated_at,
      },
    };
  } catch (error) {
    console.error('Login error:', error);
    return { success: false, error: 'Login failed' };
  }
}

export function generateToken(userId: string, email: string): string {
  const payload: JWTPayload = { userId, email };
  const options: SignOptions = {
    expiresIn: config.jwt.expiresIn as jwt.SignOptions['expiresIn'],
  };
  return jwt.sign(payload, config.jwt.secret, options);
}

export function verifyToken(token: string): JWTPayload | null {
  try {
    const decoded = jwt.verify(token, config.jwt.secret) as JWTPayload;
    return decoded;
  } catch {
    return null;
  }
}

export async function getUserById(userId: string): Promise<Omit<DBUser, 'password_hash'> | null> {
  try {
    const result = await query<DBUser>(
      `SELECT id, email, username, created_at, updated_at
       FROM users WHERE id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const user = result.rows[0];
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      created_at: user.created_at,
      updated_at: user.updated_at,
    };
  } catch (error) {
    console.error('Get user error:', error);
    return null;
  }
}
