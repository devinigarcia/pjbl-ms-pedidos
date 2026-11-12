-- =====================================================================
-- Conecta Store - ms-pedidos
-- Esquema do banco (Azure SQL Database / SQL Server 2016 ou mais novo)
--
-- O serviço roda exatamente estes comandos sozinho quando sobe
-- (src/infrastructure/sql/migrations.ts), então normalmente NÃO é preciso
-- executar este arquivo. Ele existe como documentação e para quem quiser
-- criar o banco à mão (Query Editor do portal, sqlcmd, Azure Data Studio).
--
-- Todos os comandos são idempotentes: pode rodar mais de uma vez.
-- =====================================================================

-- Pedidos
IF OBJECT_ID(N'dbo.Orders', N'U') IS NULL
CREATE TABLE dbo.Orders (
    Id            UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_Orders PRIMARY KEY,
    CustomerName  NVARCHAR(120)    NOT NULL,
    CustomerEmail NVARCHAR(160)    NOT NULL,
    Status        NVARCHAR(20)     NOT NULL
        CONSTRAINT CK_Orders_Status CHECK (Status IN (N'PENDENTE', N'PAGO', N'ENVIADO', N'ENTREGUE', N'CANCELADO')),
    Total         DECIMAL(12,2)    NOT NULL CONSTRAINT CK_Orders_Total CHECK (Total >= 0),
    Notes         NVARCHAR(500)    NULL,
    CreatedAt     DATETIME2(3)     NOT NULL,
    UpdatedAt     DATETIME2(3)     NOT NULL
);
GO

-- Itens do pedido (apagados junto com o pedido pelo ON DELETE CASCADE)
IF OBJECT_ID(N'dbo.OrderItems', N'U') IS NULL
CREATE TABLE dbo.OrderItems (
    Id          INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_OrderItems PRIMARY KEY,
    OrderId     UNIQUEIDENTIFIER  NOT NULL
        CONSTRAINT FK_OrderItems_Orders FOREIGN KEY REFERENCES dbo.Orders (Id) ON DELETE CASCADE,
    ProductId   NVARCHAR(64)      NOT NULL,
    ProductName NVARCHAR(160)     NOT NULL,
    UnitPrice   DECIMAL(12,2)     NOT NULL CONSTRAINT CK_OrderItems_UnitPrice CHECK (UnitPrice > 0),
    Quantity    INT               NOT NULL CONSTRAINT CK_OrderItems_Quantity CHECK (Quantity BETWEEN 1 AND 999)
);
GO

-- Transactional Outbox: eventos gravados na mesma transação do pedido.
-- ProcessedAt NULL = ainda não publicado na fila.
IF OBJECT_ID(N'dbo.OutboxMessages', N'U') IS NULL
CREATE TABLE dbo.OutboxMessages (
    Id          UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_OutboxMessages PRIMARY KEY,
    Type        NVARCHAR(50)     NOT NULL,
    AggregateId UNIQUEIDENTIFIER NOT NULL,
    Payload     NVARCHAR(MAX)    NOT NULL,
    OccurredAt  DATETIME2(3)     NOT NULL,
    ProcessedAt DATETIME2(3)     NULL,
    Attempts    INT              NOT NULL CONSTRAINT DF_OutboxMessages_Attempts DEFAULT (0),
    LastError   NVARCHAR(1000)   NULL
);
GO

-- Listagem de pedidos: mais recentes primeiro
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Orders_CreatedAt' AND object_id = OBJECT_ID(N'dbo.Orders'))
CREATE INDEX IX_Orders_CreatedAt ON dbo.Orders (CreatedAt DESC, Id DESC);
GO

-- Listagem filtrada por status
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Orders_Status_CreatedAt' AND object_id = OBJECT_ID(N'dbo.Orders'))
CREATE INDEX IX_Orders_Status_CreatedAt ON dbo.Orders (Status, CreatedAt DESC);
GO

-- Busca dos itens de um pedido (e da página inteira de pedidos)
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_OrderItems_OrderId' AND object_id = OBJECT_ID(N'dbo.OrderItems'))
CREATE INDEX IX_OrderItems_OrderId ON dbo.OrderItems (OrderId);
GO

-- Relay: mensagens pendentes (ProcessedAt IS NULL), das mais antigas para as mais novas
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_OutboxMessages_ProcessedAt_OccurredAt' AND object_id = OBJECT_ID(N'dbo.OutboxMessages'))
CREATE INDEX IX_OutboxMessages_ProcessedAt_OccurredAt ON dbo.OutboxMessages (ProcessedAt, OccurredAt);
GO

-- GET /events: mais recentes primeiro
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_OutboxMessages_OccurredAt' AND object_id = OBJECT_ID(N'dbo.OutboxMessages'))
CREATE INDEX IX_OutboxMessages_OccurredAt ON dbo.OutboxMessages (OccurredAt DESC);
GO

-- Eventos de um pedido específico (útil para investigar no Query Editor)
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_OutboxMessages_AggregateId' AND object_id = OBJECT_ID(N'dbo.OutboxMessages'))
CREATE INDEX IX_OutboxMessages_AggregateId ON dbo.OutboxMessages (AggregateId);
GO
