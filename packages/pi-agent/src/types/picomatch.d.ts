declare module 'picomatch' {
  type Pattern = string | RegExp | readonly (string | RegExp)[];

  interface Options {
    nodupes?: boolean;
    onResult?: (res: boolean) => void;
    onIgnore?: (glob: string) => void;
    cast?: (value: string) => string;
    contains?: string | RegExp;
    ignore?: string | RegExp;
    format?: (input: string) => string;
    source?: boolean;
    bash?: boolean;
    fast?: boolean;
    nocase?: boolean;
    noext?: boolean;
    nonegate?: boolean;
    nobrace?: boolean;
    globstar?: boolean;
    dot?: boolean;
    windows?: boolean;
  }

  function picomatch(
    glob: Pattern | readonly Pattern[],
    options?: Options,
    seen?: Set<string>,
  ): (input: string) => boolean;

  namespace picomatch {
    function test(
      glob: Pattern,
      input: string,
      options?: Options,
      seen?: Set<string>,
    ): boolean;
  }

  export = picomatch;
}
