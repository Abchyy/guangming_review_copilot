type WxRequestMethod = "GET" | "POST" | "PATCH" | "DELETE";

type WxRequestOptions<T> = {
  url: string;
  method?: WxRequestMethod;
  data?: unknown;
  header?: Record<string, string>;
  timeout?: number;
  success: (response: { statusCode: number; data: T; header: Record<string, string> }) => void;
  fail: (error: { errMsg: string }) => void;
};

declare const wx: {
  login(options: {
    timeout?: number;
    success: (result: { code: string }) => void;
    fail: (error: { errMsg: string }) => void;
  }): void;
  request<T>(options: WxRequestOptions<T>): void;
  showToast(options: { title: string; icon: "success" | "error" | "none"; duration?: number }): void;
  showModal(options: {
    title: string;
    content: string;
    showCancel?: boolean;
    cancelText?: string;
    confirmText?: string;
    confirmColor?: string;
    success?: (result: { confirm: boolean; cancel: boolean }) => void;
    fail?: (error: { errMsg: string }) => void;
  }): void;
};

type PageInstance<TData> = {
  data: TData;
  setData(update: Partial<TData> | Record<string, unknown>, callback?: () => void): void;
};

declare function App(options: { globalData?: Record<string, unknown> }): void;

declare function Page<TData, TCustom = object>(
  options: TCustom &
    ThisType<PageInstance<TData> & TCustom> & {
      data: TData;
      onLoad?(query?: Record<string, string>): void;
      onUnload?(): void;
      onShow?(): void;
      onHide?(): void;
    },
): void;
