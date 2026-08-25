import { Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';

export function validateBody(schema: z.ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const firstIssue = err.issues[0];
        const errorMessage = firstIssue
          ? `${firstIssue.path.join('.') || 'body'}: ${firstIssue.message}`
          : 'Invalid request payload format';

        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: errorMessage,
            details: err.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          },
        });
      }
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Malformed request body',
        },
      });
    }
  };
}

// 1. Auth Schemas
export const registerSchema = z.object({
  org_name: z.string().trim().min(2, 'Organization name must be at least 2 characters').max(255).optional(),
  email: z.string().trim().email('Invalid email address format'),
  password: z.string().min(6, 'Password must be at least 6 characters').max(128),
});

export const loginSchema = z.object({
  email: z.string().trim().email('Invalid email address format'),
  password: z.string().min(1, 'Password is required'),
});

// 2. Project Schema
export const createProjectSchema = z.object({
  name: z.string().trim().min(1, 'Project name is required').max(255),
});

// 3. Queue Schemas
export const createQueueSchema = z.object({
  project_id: z.string().uuid('project_id must be a valid UUID'),
  name: z.string().trim().min(1, 'Queue name is required').max(100),
  priority: z.coerce.number().int().min(1).max(100).default(1).optional(),
  concurrency_limit: z.coerce.number().int().min(1).max(1000).default(10).optional(),
  retry_policy_id: z.string().uuid('retry_policy_id must be a valid UUID').nullable().optional(),
});

export const updateQueueSchema = z.object({
  is_paused: z.boolean().optional(),
  concurrency_limit: z.coerce.number().int().min(1).max(1000).optional(),
  priority: z.coerce.number().int().min(1).max(100).optional(),
});

// 4. Job Schemas
export const createJobSchema = z.object({
  queue_id: z.string().uuid('queue_id must be a valid UUID'),
  job_type: z.enum(['IMMEDIATE', 'DELAYED', 'RECURRING', 'BATCH']).default('IMMEDIATE').optional(),
  payload: z.record(z.string(), z.any()),
  priority: z.coerce.number().int().min(1).max(100).default(1).optional(),
  delay_seconds: z.coerce.number().int().min(0).max(2592000).default(0).optional(),
  max_retries: z.coerce.number().int().min(0).max(20).default(3).optional(),
});

export const createBatchJobsSchema = z.object({
  queue_id: z.string().uuid('queue_id must be a valid UUID'),
  jobs: z
    .array(
      z.object({
        job_type: z.string().default('BATCH').optional(),
        payload: z.record(z.string(), z.any()),
        priority: z.coerce.number().int().min(1).max(100).default(1).optional(),
      })
    )
    .min(1, 'jobs array must contain at least 1 job item')
    .max(500, 'batch size cannot exceed 500 jobs per request'),
});

// 5. Scheduled Cron Job Schema
export const createScheduledJobSchema = z.object({
  queue_id: z.string().uuid('queue_id must be a valid UUID'),
  name: z.string().trim().min(1, 'Scheduled job name is required').max(255),
  cron_expression: z.string().trim().min(5, 'Valid cron expression is required (e.g. * * * * *)'),
  payload: z.record(z.string(), z.any()).default({}).optional(),
});