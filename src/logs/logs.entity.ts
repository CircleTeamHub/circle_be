// Plain class — used as a CASL subject type only.
// TypeORM removed. Database persistence for logs is out of scope for this round.
export class Logs {
  id: number;
  path: string;
  methods: string;
  data: string;
  result: number;
}
