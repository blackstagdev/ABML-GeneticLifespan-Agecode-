import prisma from "../db.server";

// Render health check.
export const loader = async () => {
  await prisma.$queryRaw`SELECT 1`;
  return new Response("ok", { headers: { "Content-Type": "text/plain" } });
};
