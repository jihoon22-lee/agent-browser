/** Conversations may run browser requests side by side unless the person turned it off. */
export const concurrentRequestsOn = (stored: { concurrentRequests?: unknown }) => stored.concurrentRequests !== false;
