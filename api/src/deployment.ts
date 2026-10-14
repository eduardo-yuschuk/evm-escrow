import { readFile } from "node:fs/promises";

import { isAddress, isHex, type Address, type Hash } from "viem";
import { z } from "zod";

import { FatalError } from "./errors.js";

const addressSchema = z
  .string()
  .refine((value) => isAddress(value), "invalid address")
  .transform((value) => value.toLowerCase() as Address);

const deploymentSchema = z.object({
  chainId: z.number().int().positive(),
  escrow: addressSchema,
  token: addressSchema,
  cancelWindow: z.number().int().positive(),
  ttl: z.number().int().positive(),
  startBlock: z
    .number()
    .int()
    .nonnegative()
    .transform((value) => BigInt(value)),
  startBlockHash: z
    .string()
    .refine((value) => isHex(value) && value.length === 66, "invalid block hash")
    .transform((value) => value.toLowerCase() as Hash),
});

/**
 * Contents of deployments/<chainId>.json, written by contracts/script/Deploy.s.sol. Addresses and
 * hashes are lowercase. `startBlock` is the last block mined before the deployment, so indexing
 * from the next block misses no event, and its hash tells this chain apart from a restarted one.
 */
export type Deployment = z.infer<typeof deploymentSchema>;

export async function loadDeployment(file: string): Promise<Deployment> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new FatalError(`Cannot read the deployments file ${file} (was the contract deployed?)`, {
      cause: error,
    });
  }
  const result = deploymentSchema.safeParse(json);
  if (!result.success) {
    throw new FatalError(`Invalid deployments file ${file}:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
