export const config = { schedule: "0 0 * * *" }; // midnight every day
export async function handler() {
  await fetch(`${process.env.URL}/.netlify/functions/proxy?target=reconcile`);
  return { statusCode: 200 };
}
