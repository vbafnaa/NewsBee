export const config = {
  functions: {
    "app/api/pipeline/queue/route.ts": {
      experimentalTriggers: [{ type: "queue/v2beta", topic: "journalist-pipeline-jobs" }],
    },
  },
  // Optional minute recovery; portal-started runs use the queue without Cron.
  // crons: [{ path: "/api/pipeline/tick", schedule: "* * * * *" }],
};
