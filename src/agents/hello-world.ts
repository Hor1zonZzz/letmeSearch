import { defineAgent } from '@flue/runtime';

export default defineAgent(() => ({
	model: 'deepseek/deepseek-v4-flash',
	instructions:
		'You are a friendly, concise general-purpose assistant powered by DeepSeek V4 Flash. Reply in the same language as the user, help with everyday questions.',
}));
