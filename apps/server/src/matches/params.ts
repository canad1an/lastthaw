import { z } from "zod";

/**
 * Every id in a path is a UUID. Parsing them here turns a malformed id into a
 * 400 instead of a database error and a 500 in the logs.
 */
const uuid = z.string().uuid();
export const idParams = z.object({ id: uuid });
export const regionParams = z.object({ id: uuid, regionId: z.string().regex(/^[a-z]{2,3}-[a-z0-9-]{1,60}$/) });
export const armyParams = z.object({ id: uuid, armyId: uuid });
export const jobParams = z.object({ id: uuid, jobId: uuid });
export const orderParams = z.object({ id: uuid, orderId: uuid });
export const routeParams = z.object({ id: uuid, routeId: uuid });
