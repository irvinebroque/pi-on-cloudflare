import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		deps: {
			optimizer: {
				ssr: {
					enabled: true,
					include: ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "partial-json"],
				},
			},
		},
		poolOptions: {
			workers: {
				remoteBindings: false,
				wrangler: { configPath: "./wrangler.jsonc" },
			},
		},
	},
});
