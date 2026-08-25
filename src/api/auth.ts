import { Request, Response, NextFunction } from 'express';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { pool } from '../db';

if (!process.env.JWT_SECRET) {
  throw new Error('FATAL SECURITY ERROR: JWT_SECRET environment variable is missing in .env. Application halted.');
}

const JWT_SECRET: string = process.env.JWT_SECRET;

export interface AuthRequest extends Request {
  user?: {
    id: string;
    org_id: string;
    email: string;
    role: string;
    project_id?: string;
  };
}

export function generateToken(payload: { id: string; org_id: string; email: string; role: string }): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });
}

export function generateSecureApiKey(): string {
  return `pk_live_${crypto.randomBytes(24).toString('hex')}`;
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const apiKey = req.headers['x-api-key'] as string;
  const authHeader = req.headers.authorization;

  // 1. API Key Auth Strategy (Service-to-Service)
  if (apiKey) {
    try {
      const projRes = await pool.query(
        `SELECT p.id as project_id, p.org_id, o.name as org_name 
         FROM projects p 
         JOIN organizations o ON p.org_id = o.id 
         WHERE p.api_key = $1`,
        [apiKey]
      );
      if (projRes.rows.length === 0) {
        return res.status(401).json({ error: { code: 'INVALID_API_KEY', message: 'The provided x-api-key is invalid.' } });
      }
      req.user = {
        id: `svc_${projRes.rows[0].project_id}`,
        org_id: projRes.rows[0].org_id,
        email: `service@${projRes.rows[0].org_name.toLowerCase().replace(/\s+/g, '')}.internal`,
        role: 'SERVICE',
        project_id: projRes.rows[0].project_id
      };
      return next();
    } catch (err: any) {
      return res.status(500).json({ error: { code: 'AUTH_ERROR', message: err.message } });
    }
  }

  // 2. JWT Bearer Token Strategy
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: { code: 'UNAUTHENTICATED', message: 'Missing Authorization header. Provide Bearer token or x-api-key.' }
    });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({
      error: { code: 'INVALID_TOKEN', message: 'Expired or invalid authentication token.' }
    });
  }
}

export function requireRole(allowedRoles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user || (!allowedRoles.includes(req.user.role) && req.user.role !== 'SERVICE')) {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: `Access denied. Requires one of [${allowedRoles.join(', ')}] role.` }
      });
    }
    next();
  };
}