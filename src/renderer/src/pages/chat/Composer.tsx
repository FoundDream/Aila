import {
  ArchiveIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  ClockIcon,
  FileTextIcon,
  ImageIcon,
  NotebookTextIcon,
  PlusIcon,
  PuzzleIcon,
  RotateCcwIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ModelPicker } from "@/components/ModelPicker";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
  ChatAttachmentInput,
  DocSummary,
  ExtensionSkillReport,
  ModelSelection,
  ProviderId,
  Settings,
  UsageInfo,
} from "../../types";
import type { QueuedRun } from "./useChatStreams";

interface ComposerProps {
  isStreaming: boolean;
  onSubmit: (
    text: string,
    attachments: ChatAttachmentInput[],
  ) => Promise<void> | void;
  onCompact: () => Promise<{ compacted: boolean }> | { compacted: boolean };
  onAbort: () => void;
  queuedRuns?: QueuedRun[];
  usage?: UsageInfo | null;
  contextLength?: number | null;
  configuredProviders: ProviderId[];
  selection: ModelSelection | null;
  onSelectionChange: (selection: ModelSelection) => void;
  onOpenSettings: () => void;
  recentOpenRouterModels: string[];
  approvalMode: ApprovalMode;
  onApprovalModeChange: (mode: ApprovalMode) => Promise<void> | void;
}

// image-store enforces 10MB on disk; stay below it so base64 inflation and
// IPC overhead never push a valid pick over the limit.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;

type ApprovalMode = NonNullable<Settings["approvalMode"]>;

const APPROVAL_MODES: Array<{
  id: ApprovalMode;
  label: string;
  description: string;
}> = [
  {
    id: "safe",
    label: "Safe",
    description: "Ask before write, edit, and shell tools.",
  },
  {
    id: "yolo",
    label: "Yolo",
    description: "Run tools without approval prompts.",
  },
];

type SlashCommandId = "image" | "compact";

interface SlashState {
  rangeStart: number;
  rangeEnd: number;
  query: string;
}

interface SlashCommand {
  id: string;
  kind: "builtin" | "skill";
  commandId?: SlashCommandId;
  skillName?: string;
  token: string;
  label: string;
  description: string;
  keywords: string[];
  icon: ReactElement;
}

interface PendingAttachment {
  id: string;
  kind: "image" | "text" | "doc";
  name: string;
  mime: string;
  /** kind 'image': base64 (no data: prefix). otherwise raw text. */
  data: string;
  /** data: URL for image thumbnails. */
  previewUrl?: string;
}

function compactTextPreview(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function pluralize(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function queuedRunPreview(queued: QueuedRun): string {
  if (queued.kind === "retryLast") return "Resume last turn";
  const text = compactTextPreview(queued.text);
  if (text) return text;
  return queued.attachments.length > 0
    ? "Attachment-only prompt"
    : "Empty prompt";
}

function queuedRunMeta(queued: QueuedRun): string | null {
  if (queued.kind === "retryLast") return "Retry";
  const images = queued.attachments.filter(
    (attachment) => attachment.kind === "image",
  ).length;
  const files = queued.attachments.length - images;
  const parts = [
    images > 0 ? pluralize(images, "image") : null,
    files > 0 ? pluralize(files, "file") : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}

function getSlashState(text: string, cursor: number): SlashState | null {
  const beforeCursor = text.slice(0, cursor);
  const rangeStart = beforeCursor.lastIndexOf("/");
  if (rangeStart < 0) return null;

  const charBefore = rangeStart > 0 ? text[rangeStart - 1] : "";
  if (charBefore && !/\s/.test(charBefore)) return null;

  const query = beforeCursor.slice(rangeStart + 1);
  if (query.includes("\n") || /\s/.test(query)) return null;

  return { rangeStart, rangeEnd: cursor, query };
}

function slashCommandMatches(command: SlashCommand, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const token = command.token.slice(1).toLowerCase();
  return (
    token.startsWith(q) ||
    command.label.toLowerCase().includes(q) ||
    command.description.toLowerCase().includes(q) ||
    command.keywords.some((keyword) => keyword.includes(q))
  );
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10_000) return `${(n / 1000).toFixed(2)}k`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () =>
      reject(reader.error ?? new Error("failed to read file"));
    reader.readAsDataURL(file);
  });
}

function ContextRing({ ratio }: { ratio: number }): ReactElement {
  const r = 7;
  const circumference = 2 * Math.PI * r;
  // Keep a sliver visible once anything has been used so the indicator
  // doesn't read as "empty" at the start of a conversation.
  const shown = ratio > 0 ? Math.max(ratio, 0.04) : 0;
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        opacity="0.2"
      />
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - shown)}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}

function AttachMenuItem({
  icon,
  label,
  onClick,
}: {
  icon: ReactElement;
  label: string;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-[var(--text-soft)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
    >
      <span className="grid size-4 place-items-center text-[var(--text-dim)]">
        {icon}
      </span>
      {label}
    </button>
  );
}

function SlashCommandMenu({
  commands,
  selectedIndex,
  onSelectCommand,
  onHighlight,
}: {
  commands: SlashCommand[];
  selectedIndex: number;
  onSelectCommand: (command: SlashCommand) => void;
  onHighlight: (index: number) => void;
}): ReactElement {
  return (
    <div className="flex max-h-72 flex-col overflow-y-auto" role="listbox">
      {commands.length === 0 ? (
        <p className="px-2 py-2 text-[12px] text-[var(--text-dim)]">
          No commands found.
        </p>
      ) : (
        commands.map((command, index) => {
          const selected = index === selectedIndex;
          return (
            <button
              key={command.id}
              type="button"
              role="option"
              aria-selected={selected}
              onMouseEnter={() => onHighlight(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSelectCommand(command)}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                selected
                  ? "bg-[var(--surface-hover)]"
                  : "hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
              }`}
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-md border border-[var(--border)] bg-[var(--bg-soft)] text-[var(--text-soft)]">
                {command.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-[12.5px] font-medium text-[var(--text)]">
                    {command.label}
                  </span>
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-[var(--text-dim)]">
                  {command.description}
                </span>
              </span>
              <span className="shrink-0 rounded border border-[var(--border)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-dim)]">
                {command.token}
              </span>
            </button>
          );
        })
      )}
    </div>
  );
}

function QueuedRunsList({
  queuedRuns,
}: {
  queuedRuns: QueuedRun[];
}): ReactElement | null {
  if (queuedRuns.length === 0) return null;

  return (
    <div className="border-b border-[var(--border)] px-4 py-2.5">
      <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[11.5px] font-medium text-[var(--text-dim)]">
        <ClockIcon className="size-3.5" />
        <span>Queue</span>
      </div>
      <div className="flex max-h-32 flex-col gap-1 overflow-y-auto pr-1">
        {queuedRuns.map((queued, index) => {
          const preview = queuedRunPreview(queued);
          const meta = queuedRunMeta(queued);
          return (
            <div
              key={queued.id}
              className="flex min-h-7 items-center gap-2 rounded-lg px-2 py-1 text-[12px] text-[var(--text-soft)]"
            >
              <span className="w-9 shrink-0 text-[11px] text-[var(--text-dim)]">
                {index === 0 ? "Next" : `#${index + 1}`}
              </span>
              <span className="grid size-4 shrink-0 place-items-center text-[var(--text-dim)]">
                {queued.kind === "retryLast" ? (
                  <RotateCcwIcon className="size-3.5" />
                ) : (
                  <ArrowUpIcon className="size-3.5" />
                )}
              </span>
              <span className="min-w-0 flex-1 truncate" title={preview}>
                {preview}
              </span>
              {meta && (
                <span className="max-w-28 shrink-0 truncate text-[11px] text-[var(--text-dim)]">
                  {meta}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function Composer({
  isStreaming,
  onSubmit,
  onCompact,
  onAbort,
  queuedRuns = [],
  usage,
  contextLength,
  configuredProviders,
  selection,
  onSelectionChange,
  onOpenSettings,
  recentOpenRouterModels,
  approvalMode,
  onApprovalModeChange,
}: ComposerProps): ReactElement {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuView, setMenuView] = useState<"main" | "docs">("main");
  const [modeOpen, setModeOpen] = useState(false);
  const [modeSaving, setModeSaving] = useState(false);
  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  const [skills, setSkills] = useState<ExtensionSkillReport[]>([]);
  const [slashState, setSlashState] = useState<SlashState | null>(null);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const textInputRef = useRef<HTMLInputElement | null>(null);
  const slashMenuRef = useRef<HTMLDivElement | null>(null);

  const addImageFiles = useCallback(async (files: File[]) => {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      if (file.size > MAX_IMAGE_BYTES) {
        setAttachError(`${file.name || "Image"} is too large (max 8MB)`);
        continue;
      }
      try {
        const dataUrl = await readAsDataUrl(file);
        const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
        setAttachments((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            kind: "image",
            name: file.name || "pasted-image.png",
            mime: file.type,
            data: base64,
            previewUrl: dataUrl,
          },
        ]);
        setAttachError(null);
      } catch {
        setAttachError(`Could not read ${file.name || "image"}`);
      }
    }
  }, []);

  const addTextFile = useCallback(async (file: File) => {
    if (file.size > MAX_TEXT_BYTES) {
      setAttachError(`${file.name} is too large (max 512KB)`);
      return;
    }
    try {
      const content = await file.text();
      if (content.includes("\0")) {
        setAttachError(`${file.name} looks like a binary file`);
        return;
      }
      setAttachments((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          kind: "text",
          name: file.name,
          mime: file.type || "text/plain",
          data: content,
        },
      ]);
      setAttachError(null);
    } catch {
      setAttachError(`Could not read ${file.name}`);
    }
  }, []);

  const addDocReference = useCallback(async (doc: DocSummary) => {
    try {
      const record = await window.api.docs.get(doc.path);
      setAttachments((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          kind: "doc",
          name: `${record.title || doc.path}.md`,
          mime: "text/markdown",
          data: record.content,
        },
      ]);
      setAttachError(null);
    } catch {
      setAttachError(`Could not read doc ${doc.title || doc.path}`);
    }
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const loadDocs = useCallback(() => {
    setDocs(null);
    void window.api.docs
      .list()
      .then((result) => setDocs(result.docs))
      .catch(() => setDocs([]));
  }, []);

  const openDocsView = useCallback(() => {
    setMenuView("docs");
    loadDocs();
  }, [loadDocs]);

  // Sends always succeed even while streaming: they're queued and fire after
  // the current run finishes. The primary action becomes Stop while empty.
  const submit = useCallback(async () => {
    const text = value;
    if (!text.trim() && attachments.length === 0) return;
    const outgoing: ChatAttachmentInput[] = attachments.map((a) => ({
      kind: a.kind === "image" ? "image" : "text",
      name: a.name,
      mime: a.mime,
      data: a.data,
    }));
    setValue("");
    setAttachments([]);
    setAttachError(null);
    setSlashState(null);
    setSlashSelectedIndex(0);
    await onSubmit(text, outgoing);
  }, [value, attachments, onSubmit]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  });

  const updateSlashFromTextarea = useCallback(
    (text: string, cursor: number) => {
      const nextSlashState = getSlashState(text, cursor);
      setSlashState(nextSlashState);
      if (nextSlashState) setSlashSelectedIndex(0);
    },
    [],
  );

  const handleTextareaChange = useCallback(
    (text: string, cursor: number) => {
      setValue(text);
      updateSlashFromTextarea(text, cursor);
    },
    [updateSlashFromTextarea],
  );

  const replaceSlashToken = useCallback(
    (replacement: string) => {
      const active = slashState;
      if (!active) return;

      const nextCursor = active.rangeStart + replacement.length;
      setValue(
        (prev) =>
          `${prev.slice(0, active.rangeStart)}${replacement}${prev.slice(active.rangeEnd)}`,
      );
      setSlashState(null);
      setSlashSelectedIndex(0);

      window.requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(nextCursor, nextCursor);
      });
    },
    [slashState],
  );

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(event.clipboardData.items)
        .filter(
          (item) => item.kind === "file" && item.type.startsWith("image/"),
        )
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      if (files.length === 0) return;
      event.preventDefault();
      void addImageFiles(files);
    },
    [addImageFiles],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const files = Array.from(event.dataTransfer.files);
      if (files.length === 0) return;
      event.preventDefault();
      for (const file of files) {
        if (file.type.startsWith("image/")) void addImageFiles([file]);
        else void addTextFile(file);
      }
    },
    [addImageFiles, addTextFile],
  );

  const canSend = value.trim().length > 0 || attachments.length > 0;
  const primaryActionIsAbort = isStreaming && !canSend;
  const primaryActionLabel = primaryActionIsAbort
    ? "Stop"
    : isStreaming
      ? "Queue follow-up"
      : "Send";
  const primaryActionDisabled = !primaryActionIsAbort && !canSend;
  const activeApprovalMode = approvalMode ?? "safe";
  const activeApprovalModeMeta = APPROVAL_MODES.find(
    (mode) => mode.id === activeApprovalMode,
  );
  const slashActive = slashState !== null;

  const handlePrimaryAction = useCallback(() => {
    if (primaryActionIsAbort) {
      onAbort();
      return;
    }
    void submit();
  }, [primaryActionIsAbort, onAbort, submit]);

  const setToolMode = useCallback(
    async (mode: ApprovalMode) => {
      if (mode === activeApprovalMode || modeSaving) {
        setModeOpen(false);
        return;
      }
      setModeSaving(true);
      try {
        await onApprovalModeChange(mode);
        setModeOpen(false);
      } finally {
        setModeSaving(false);
      }
    },
    [activeApprovalMode, modeSaving, onApprovalModeChange],
  );

  const slashCommands = useMemo<SlashCommand[]>(
    () => [
      {
        id: "image",
        kind: "builtin",
        commandId: "image",
        token: "/image",
        label: "Image mode",
        description: "Attach images to this prompt",
        keywords: ["image", "photo", "picture", "screenshot", "png", "jpg"],
        icon: <ImageIcon className="size-3.5" />,
      },
      {
        id: "compact",
        kind: "builtin",
        commandId: "compact",
        token: "/compact",
        label: "Compact context",
        description: "Summarize older history into a checkpoint",
        keywords: ["compact", "context", "summary", "checkpoint"],
        icon: <ArchiveIcon className="size-3.5" />,
      },
      ...skills.map((skill) => ({
        id: `skill:${skill.name}`,
        kind: "skill" as const,
        skillName: skill.name,
        token: `/${skill.name}`,
        label: skill.name,
        description: skill.description,
        keywords: [
          "skill",
          skill.name,
          ...skill.description.toLowerCase().split(/[^a-z0-9-]+/),
        ],
        icon: <PuzzleIcon className="size-3.5" />,
      })),
    ],
    [skills],
  );

  const filteredSlashCommands = useMemo(() => {
    const query = slashState?.query ?? "";
    return slashCommands.filter((command) =>
      slashCommandMatches(command, query),
    );
  }, [slashCommands, slashState?.query]);

  useEffect(() => {
    if (!slashActive) return;
    let cancelled = false;
    void (async () => {
      try {
        const report = await window.api.extensions.report();
        if (!cancelled) setSkills(report.skills);
      } catch {
        if (!cancelled) setSkills([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slashActive]);

  useEffect(() => {
    if (!slashState) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (slashMenuRef.current?.contains(target)) return;
      if (textareaRef.current?.contains(target)) return;
      setSlashState(null);
    };

    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, [slashState]);

  const runSlashCommand = useCallback(
    (command: SlashCommand) => {
      if (command.kind === "skill" && command.skillName) {
        replaceSlashToken(`/${command.skillName} `);
        return;
      }

      replaceSlashToken("");
      if (command.commandId === "image") imageInputRef.current?.click();
      if (command.commandId === "compact") {
        void (async () => {
          try {
            const result = await onCompact();
            setAttachError(result.compacted ? null : "Nothing to compact yet.");
          } catch (error) {
            setAttachError(
              error instanceof Error ? error.message : String(error),
            );
          }
        })();
      }
    },
    [onCompact, replaceSlashToken],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (slashState) {
        const itemCount = filteredSlashCommands.length;

        if (event.key === "Escape") {
          event.preventDefault();
          setSlashState(null);
          return;
        }

        if (
          itemCount > 0 &&
          (event.key === "ArrowDown" || event.key === "ArrowUp")
        ) {
          event.preventDefault();
          setSlashSelectedIndex((index) => {
            const delta = event.key === "ArrowDown" ? 1 : -1;
            return (index + delta + itemCount) % itemCount;
          });
          return;
        }

        if (
          itemCount > 0 &&
          (event.key === "Enter" || event.key === "Tab") &&
          !event.shiftKey &&
          !event.nativeEvent.isComposing
        ) {
          event.preventDefault();
          const index = Math.min(slashSelectedIndex, itemCount - 1);
          runSlashCommand(filteredSlashCommands[index]);
          return;
        }
      }

      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.nativeEvent.isComposing
      ) {
        event.preventDefault();
        void submit();
      }
    },
    [
      filteredSlashCommands,
      runSlashCommand,
      slashSelectedIndex,
      slashState,
      submit,
    ],
  );

  const used = usage?.totalTokens ?? 0;
  const ratio =
    contextLength && contextLength > 0 ? Math.min(used / contextLength, 1) : 0;
  const showMeter = (contextLength ?? 0) > 0 || used > 0;
  const meterColor =
    ratio >= 0.9
      ? "text-red-500"
      : ratio >= 0.75
        ? "text-amber-500"
        : "text-[var(--text-dim)]";

  return (
    <div className="shrink-0 px-6 pb-6 pt-2">
      <div className="mx-auto max-w-[680px]">
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
          className="relative rounded-[24px] border border-[var(--border)] bg-[var(--surface)] shadow-[0_2px_14px_rgba(0,0,0,0.035)] transition-shadow focus-within:shadow-[0_3px_18px_rgba(0,0,0,0.055)]"
        >
          {slashState && (
            <div
              ref={slashMenuRef}
              className="absolute bottom-full left-4 z-40 mb-2 w-[min(28rem,calc(100%-2rem))] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1 shadow-[0_14px_48px_rgba(0,0,0,0.14)]"
            >
              <SlashCommandMenu
                commands={filteredSlashCommands}
                selectedIndex={slashSelectedIndex}
                onSelectCommand={runSlashCommand}
                onHighlight={setSlashSelectedIndex}
              />
            </div>
          )}

          <QueuedRunsList queuedRuns={queuedRuns} />

          {(attachments.length > 0 || attachError) && (
            <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
              {attachments.map((attachment) =>
                attachment.kind === "image" ? (
                  <div key={attachment.id} className="group relative">
                    <img
                      src={attachment.previewUrl}
                      alt={attachment.name}
                      className="size-12 rounded-lg border border-[var(--border)] object-cover"
                    />
                    <button
                      type="button"
                      aria-label={`Remove ${attachment.name}`}
                      onClick={() => removeAttachment(attachment.id)}
                      className="absolute -right-1.5 -top-1.5 grid size-4 place-items-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--text-dim)] opacity-0 transition-opacity hover:text-[var(--text)] group-hover:opacity-100"
                    >
                      <XIcon className="size-2.5" />
                    </button>
                  </div>
                ) : (
                  <span
                    key={attachment.id}
                    className="inline-flex max-w-56 items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--bg-soft)] py-1 pl-2.5 pr-1.5 text-[11.5px] text-[var(--text-soft)]"
                  >
                    {attachment.kind === "doc" ? (
                      <NotebookTextIcon className="size-3 shrink-0 text-[var(--text-dim)]" />
                    ) : (
                      <FileTextIcon className="size-3 shrink-0 text-[var(--text-dim)]" />
                    )}
                    <span className="min-w-0 truncate">{attachment.name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${attachment.name}`}
                      onClick={() => removeAttachment(attachment.id)}
                      className="grid size-4 shrink-0 place-items-center rounded-full text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                    >
                      <XIcon className="size-2.5" />
                    </button>
                  </span>
                ),
              )}
              {attachError && (
                <span className="text-[11px] text-[var(--error)]">
                  {attachError}
                </span>
              )}
            </div>
          )}

          <div className="px-4 pb-1 pt-3">
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(event) =>
                handleTextareaChange(
                  event.currentTarget.value,
                  event.currentTarget.selectionStart,
                )
              }
              onSelect={(event) =>
                updateSlashFromTextarea(
                  event.currentTarget.value,
                  event.currentTarget.selectionStart,
                )
              }
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={
                isStreaming ? "Queue a follow-up" : "Ask Aila anything"
              }
              rows={1}
              className="block min-h-7 max-h-[180px] w-full resize-none overflow-y-auto bg-transparent text-[15px] leading-[1.6] text-[var(--text)] outline-none placeholder:text-[var(--text-dim)]"
            />
          </div>

          <div className="flex min-h-12 items-center justify-between gap-2 px-2.5 pb-2.5 pt-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <input
                ref={imageInputRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                multiple
                className="hidden"
                onChange={(e) => {
                  void addImageFiles(Array.from(e.target.files ?? []));
                  e.target.value = "";
                }}
              />
              <input
                ref={textInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  for (const file of Array.from(e.target.files ?? []))
                    void addTextFile(file);
                  e.target.value = "";
                }}
              />
              <Popover
                open={menuOpen}
                onOpenChange={(open) => {
                  setMenuOpen(open);
                  if (open) setSlashState(null);
                  if (open) setMenuView("main");
                }}
              >
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label="Add attachment"
                    className="grid size-8 shrink-0 place-items-center rounded-full text-[var(--text-soft)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                  >
                    <PlusIcon className="size-[18px]" />
                  </button>
                </PopoverTrigger>
                <PopoverContent side="top" align="start" className="w-56 border-0 p-1">
                  {menuView === "main" ? (
                    <div className="flex flex-col gap-px">
                      <AttachMenuItem
                        icon={<ImageIcon className="size-3.5" />}
                        label="Image…"
                        onClick={() => {
                          setMenuOpen(false);
                          imageInputRef.current?.click();
                        }}
                      />
                      <AttachMenuItem
                        icon={<FileTextIcon className="size-3.5" />}
                        label="Text file…"
                        onClick={() => {
                          setMenuOpen(false);
                          textInputRef.current?.click();
                        }}
                      />
                      <AttachMenuItem
                        icon={<NotebookTextIcon className="size-3.5" />}
                        label="Reference doc"
                        onClick={openDocsView}
                      />
                    </div>
                  ) : (
                    <div className="flex max-h-64 flex-col">
                      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--border)] px-1 pb-1">
                        <button
                          type="button"
                          aria-label="Back"
                          onClick={() => setMenuView("main")}
                          className="grid size-6 place-items-center rounded-md text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                        >
                          <ArrowLeftIcon className="size-3.5" />
                        </button>
                        <span className="text-[12px] font-medium text-[var(--text)]">
                          Docs
                        </span>
                      </div>
                      <div className="min-h-0 flex-1 overflow-y-auto pt-1">
                        {docs === null && (
                          <p className="px-2 py-2 text-[12px] text-[var(--text-dim)]">
                            Loading…
                          </p>
                        )}
                        {docs?.length === 0 && (
                          <p className="px-2 py-2 text-[12px] text-[var(--text-dim)]">
                            No documents yet.
                          </p>
                        )}
                        {docs?.map((doc) => (
                          <button
                            key={doc.path}
                            type="button"
                            onClick={() => {
                              setMenuOpen(false);
                              void addDocReference(doc);
                            }}
                            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-[var(--text-soft)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                          >
                            <NotebookTextIcon className="size-3.5 shrink-0 text-[var(--text-dim)]" />
                            <span className="min-w-0 truncate">
                              {doc.title || doc.path}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </PopoverContent>
              </Popover>
              <Popover open={modeOpen} onOpenChange={setModeOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label="Execution mode"
                    className={`inline-flex h-8 shrink-0 items-center px-1 text-[12px] outline-none transition-colors ${
                      activeApprovalMode === "safe"
                        ? "text-[var(--text-soft)] hover:text-[var(--text)] focus-visible:text-[var(--text)]"
                        : "text-amber-600 hover:text-amber-700 focus-visible:text-amber-700"
                    }`}
                  >
                    <span>{activeApprovalModeMeta?.label ?? "Safe"}</span>
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  side="top"
                  align="start"
                  className="w-64 border-0 p-1"
                >
                  <div className="flex flex-col gap-px">
                    {APPROVAL_MODES.map((mode) => {
                      const selected = activeApprovalMode === mode.id;
                      return (
                        <button
                          key={mode.id}
                          type="button"
                          onClick={() => void setToolMode(mode.id)}
                          disabled={modeSaving}
                          className={`rounded-md px-2.5 py-2 text-left outline-none transition-colors focus-visible:bg-[var(--surface-hover)] disabled:opacity-60 ${
                            selected
                              ? "bg-[var(--surface-hover)]"
                              : "hover:bg-[var(--surface-hover)]"
                          }`}
                        >
                          <span className="block text-[12px] font-medium text-[var(--text)]">
                            {mode.label}
                          </span>
                          <span className="mt-0.5 block text-[11px] leading-snug text-[var(--text-dim)]">
                            {mode.description}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </PopoverContent>
              </Popover>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {showMeter && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      role="img"
                      aria-label="Context used"
                      className={`inline-flex ${meterColor}`}
                    >
                      <ContextRing ratio={ratio} />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <div className="flex flex-col gap-0.5">
                      <span>
                        {contextLength
                          ? `Context: ${formatTokens(used)} / ${formatTokens(contextLength)} (${Math.round(ratio * 100)}%)`
                          : `Context: ${formatTokens(used)} tokens`}
                      </span>
                      {usage && (
                        <span className="opacity-60">
                          Prompt {formatTokens(usage.promptTokens)} · Completion{" "}
                          {formatTokens(usage.completionTokens)}
                        </span>
                      )}
                    </div>
                  </TooltipContent>
                </Tooltip>
              )}
              <ModelPicker
                configuredProviders={configuredProviders}
                selection={selection}
                onChange={onSelectionChange}
                onOpenSettings={onOpenSettings}
                recentOpenRouterModels={recentOpenRouterModels}
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={primaryActionLabel}
                    onClick={handlePrimaryAction}
                    disabled={primaryActionDisabled}
                    className={`grid size-8 shrink-0 place-items-center rounded-full transition disabled:cursor-not-allowed ${
                      primaryActionIsAbort
                        ? "border border-[var(--border)] bg-[var(--surface)] text-[var(--text-soft)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                        : "bg-[var(--brand-ink)] text-[var(--brand-ink-fg)] hover:opacity-85 disabled:bg-[var(--surface-hover)] disabled:text-[var(--text-dim)]"
                    }`}
                  >
                    {primaryActionIsAbort ? (
                      <SquareIcon className="size-3 fill-current" />
                    ) : (
                      <ArrowUpIcon className="size-4" strokeWidth={2.4} />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent>{primaryActionLabel}</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
