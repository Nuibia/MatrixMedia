<template>
  <el-tooltip :content="tooltip" placement="top" :open-delay="400">
    <el-button
      class="ai-generate-btn"
      size="mini"
      type="primary"
      plain
      :icon="loading ? '' : 'el-icon-magic-stick'"
      :loading="loading"
      :disabled="disabled"
      @click="run"
    >
      {{ loading ? "生成中…" : label }}
    </el-button>
  </el-tooltip>
</template>

<script>
import { generateAiContent } from "@/utils/aiContent";

const KIND_LABEL = { title: "标题", body: "正文", tags: "标签" };

/**
 * 「AI 生成」按钮：点击后用 getContext() 取当前表单素材，生成成功后 emit("generated", value)。
 * value：title/body 为字符串，tags 为字符串数组。错误统一用 $message 提示。
 */
export default {
  name: "AiGenerateButton",
  props: {
    kind: { type: String, required: true },
    getContext: { type: Function, required: true },
    label: { type: String, default: "AI 生成" },
    disabled: { type: Boolean, default: false },
  },
  data() {
    return { loading: false };
  },
  computed: {
    tooltip() {
      return `根据已填写的名称/标题/简介，用 AI 生成${KIND_LABEL[this.kind] || ""}（在「项目详情 → AI 设置」配置 API Key）`;
    },
  },
  methods: {
    async run() {
      if (this.loading) return;
      this.loading = true;
      this.$emit("loading", true);
      try {
        const res = await generateAiContent(this.kind, this.getContext() || {});
        this.$emit("generated", res.value);
        this.$message.success(`已用 ${res.providerName}（${res.model}）生成${KIND_LABEL[this.kind] || ""}`);
      } catch (e) {
        const msg = e.message || "生成失败";
        if (/还没有配置 AI 接口/.test(msg)) {
          // 不跳转页面，避免丢失正在填写的发布内容
          this.$alert(msg, "未配置 AI", { type: "info", confirmButtonText: "知道了" }).catch(() => {});
        } else {
          this.$message.error("AI 生成失败：" + msg);
        }
      } finally {
        this.loading = false;
        this.$emit("loading", false);
      }
    },
  },
};
</script>

<style lang="scss" scoped>
.ai-generate-btn {
  padding: 5px 10px;
}
</style>
