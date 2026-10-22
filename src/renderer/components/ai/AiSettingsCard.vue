<template>
  <el-card class="section-card ai-settings" shadow="never">
    <div slot="header" class="card-header">
      <span>AI 设置</span>
      <el-button type="primary" size="mini" icon="el-icon-plus" @click="openEditor()">
        添加 API Key
      </el-button>
    </div>
    <p class="section-tip">
      配置后可在「填写发布内容」里一键生成标题、简介/正文和标签。支持任何 OpenAI 兼容接口（DeepSeek、通义千问、Kimi、OpenAI 等）。
      API Key 只保存在本机，并通过系统加密存储（Windows DPAPI / macOS 钥匙串 / Linux libsecret）加密，请求由主进程直接发往你填写的接口地址。
    </p>
    <el-alert
      v-if="loaded && !secureStorage"
      type="warning"
      :closable="false"
      show-icon
      class="ai-alert"
      title="当前系统不支持加密存储，API Key 将以编码形式保存在本机配置文件中（仅当前用户可读）。"
    />
    <el-table v-loading="loading" :data="providers" border size="small" class="doc-table" empty-text="还没有配置，点击右上角「添加 API Key」">
      <el-table-column label="名称" min-width="120">
        <template slot-scope="{ row }">
          {{ row.name }}
          <el-tag v-if="row.isDefault" size="mini" type="success" class="ai-default-tag">默认</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="model" label="模型" min-width="120" show-overflow-tooltip />
      <el-table-column prop="baseURL" label="接口地址" min-width="200" show-overflow-tooltip />
      <el-table-column label="API Key" min-width="150">
        <template slot-scope="{ row }">
          <span v-if="row.keyError" class="ai-key-error">{{ row.keyError }}</span>
          <code v-else>{{ row.maskedKey || "未设置" }}</code>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="250">
        <template slot-scope="{ row }">
          <el-button size="mini" type="text" :loading="testingId === row.id" @click="testSaved(row)">测试连接</el-button>
          <el-button size="mini" type="text" :disabled="row.isDefault" @click="makeDefault(row)">设为默认</el-button>
          <el-button size="mini" type="text" @click="openEditor(row)">编辑</el-button>
          <el-button size="mini" type="text" class="ai-danger" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog
      :title="editing.id ? '编辑 AI 配置' : '添加 AI 配置'"
      :visible.sync="editorVisible"
      width="560px"
      append-to-body
      :close-on-click-modal="false"
    >
      <el-form ref="editorForm" :model="editing" label-width="96px" size="small">
        <el-form-item label="服务商">
          <el-select v-model="editing.preset" style="width: 100%" @change="applyPreset">
            <el-option v-for="p in presets" :key="p.key" :label="p.name" :value="p.key" />
          </el-select>
        </el-form-item>
        <el-form-item label="配置名称">
          <el-input v-model="editing.name" maxlength="40" placeholder="例如：DeepSeek 主账号" />
        </el-form-item>
        <el-form-item label="接口地址">
          <el-input v-model="editing.baseURL" placeholder="https://api.deepseek.com/v1" />
          <p class="form-tip">填到 /v1 即可，程序会自动拼接 /chat/completions</p>
        </el-form-item>
        <el-form-item label="模型">
          <el-input v-model="editing.model" placeholder="例如：deepseek-chat / qwen-plus" />
        </el-form-item>
        <el-form-item label="API Key">
          <el-input
            v-model="editing.apiKey"
            show-password
            autocomplete="off"
            :placeholder="editing.id ? `已保存 ${editing.maskedKey || ''}，留空表示不修改` : 'sk-...'"
          />
        </el-form-item>
        <el-form-item label="">
          <el-checkbox v-model="editing.setDefault">设为默认配置</el-checkbox>
        </el-form-item>
      </el-form>
      <div slot="footer">
        <el-button size="small" :loading="testingDraft" @click="testDraft">测试连接</el-button>
        <el-button size="small" @click="editorVisible = false">取消</el-button>
        <el-button size="small" type="primary" :loading="saving" @click="save">保存</el-button>
      </div>
    </el-dialog>
  </el-card>
</template>

<script>
import { AI_PROVIDER_PRESETS } from "../../../shared/aiContent.js";
import {
  deleteAiProvider,
  listAiProviders,
  saveAiProvider,
  setDefaultAiProvider,
  testAiProvider,
} from "@/utils/aiContent";

function blankEditing() {
  const preset = AI_PROVIDER_PRESETS[0];
  return {
    id: "",
    preset: preset.key,
    name: preset.name,
    baseURL: preset.baseURL,
    model: preset.model,
    apiKey: "",
    maskedKey: "",
    setDefault: false,
  };
}

export default {
  name: "AiSettingsCard",
  data() {
    return {
      presets: AI_PROVIDER_PRESETS,
      providers: [],
      secureStorage: true,
      loaded: false,
      loading: false,
      editorVisible: false,
      editing: blankEditing(),
      saving: false,
      testingDraft: false,
      testingId: "",
    };
  },
  mounted() {
    this.refresh();
  },
  beforeDestroy() {
    // 不在组件里长期保留明文 Key
    this.editing.apiKey = "";
  },
  methods: {
    applyResult(res) {
      this.providers = res.providers || [];
      this.secureStorage = res.secureStorage !== false;
      this.loaded = true;
    },
    async refresh() {
      this.loading = true;
      try {
        this.applyResult(await listAiProviders());
      } catch (e) {
        this.$message.error("读取 AI 设置失败：" + e.message);
      } finally {
        this.loading = false;
      }
    },
    applyPreset(key) {
      const preset = this.presets.find((p) => p.key === key);
      if (!preset) return;
      const presetNames = this.presets.map((p) => p.name);
      if (!this.editing.name || presetNames.includes(this.editing.name)) this.editing.name = preset.name;
      if (preset.key !== "custom") {
        this.editing.baseURL = preset.baseURL;
        this.editing.model = preset.model;
      }
    },
    openEditor(row) {
      this.editing = row
        ? { ...blankEditing(), ...row, apiKey: "", setDefault: row.isDefault }
        : { ...blankEditing(), setDefault: this.providers.length === 0 };
      this.editorVisible = true;
    },
    async save() {
      this.saving = true;
      try {
        const res = await saveAiProvider({ ...this.editing });
        this.applyResult(res);
        this.editing.apiKey = "";
        this.editorVisible = false;
        this.$message.success("AI 配置已保存");
      } catch (e) {
        this.$message.error(e.message);
      } finally {
        this.saving = false;
      }
    },
    async testDraft() {
      this.testingDraft = true;
      try {
        const res = await testAiProvider({ ...this.editing });
        this.$message.success(`连接成功，耗时 ${res.latencyMs} ms`);
      } catch (e) {
        this.$message.error("连接失败：" + e.message);
      } finally {
        this.testingDraft = false;
      }
    },
    async testSaved(row) {
      this.testingId = row.id;
      try {
        const res = await testAiProvider({ id: row.id });
        this.$message.success(`「${row.name}」连接成功，耗时 ${res.latencyMs} ms`);
      } catch (e) {
        this.$message.error(`「${row.name}」连接失败：${e.message}`);
      } finally {
        this.testingId = "";
      }
    },
    async makeDefault(row) {
      try {
        this.applyResult(await setDefaultAiProvider(row.id));
        this.$message.success(`已将「${row.name}」设为默认`);
      } catch (e) {
        this.$message.error(e.message);
      }
    },
    async remove(row) {
      try {
        await this.$confirm(`确定删除 AI 配置「${row.name}」吗？已保存的 API Key 会一并删除。`, "删除确认", {
          type: "warning",
          confirmButtonText: "删除",
          cancelButtonText: "取消",
        });
      } catch (_) {
        return;
      }
      try {
        this.applyResult(await deleteAiProvider(row.id));
        this.$message.success("已删除");
      } catch (e) {
        this.$message.error(e.message);
      }
    },
  },
};
</script>

<style lang="scss" scoped>
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.ai-alert {
  margin-bottom: 12px;
}
.ai-default-tag {
  margin-left: 6px;
}
.ai-danger {
  color: #f56c6c;
}
.ai-key-error {
  color: #f56c6c;
  font-size: 12px;
}
.form-tip {
  margin: 4px 0 0;
  font-size: 12px;
  color: #909399;
  line-height: 1.5;
}
</style>
