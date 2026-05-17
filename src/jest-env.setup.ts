// Jest env bootstrap — runs before every test file.
//
// Importing `AppModule` (e.g. transitively via `main.spec.ts`) evaluates
// `ConfigModule.forRoot({ validationSchema })`, whose Joi schema requires
// `DATABASE_URL` and `SECRET`. The committed `.env*` files were removed from
// version control, so provide harmless placeholders here. Tests mock
// `PrismaService` and never open a real connection.
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.SECRET ??= 'test-secret-test-secret-test-secret-0123';
